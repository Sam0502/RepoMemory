import { EntityRepository, RelationshipRepository, CommitRepository } from '@repo-memory/storage';
import { GraphClient } from '@repo-memory/graph';
import { Entity, Relationship, RelationshipType } from '@repo-memory/shared';
import { detectDeadCode } from '@repo-memory/analysis';
import { Pool } from 'pg';

export interface QaAnswer {
  question: string;
  intent: string;
  entity?: Entity;
  answer: string;
  evidence: Array<{ type: string; description: string }>;
}

const STOP_WORDS = new Set([
  'what', 'who', 'where', 'which', 'how', 'does', 'do', 'is', 'are', 'the', 'a',
  'an', 'of', 'in', 'for', 'to', 'this', 'that', 'it', 'on', 'me', 'tell',
  'about', 'can', 'you', 'describe', 'show', 'list', 'its', 'and', 'or', 'not',
  'why', 'when', 'call', 'calls', 'called', 'use', 'uses', 'used', 'import',
  'imports', 'imported', 'depend', 'depends', 'dependencies', 'dependency',
  'dependent', 'dependents', 'test', 'tests', 'testing', 'cover', 'covers',
  'covered', 'dead', 'code', 'owned', 'owns', 'owner', 'ownership', 'written',
  'wrote', 'by', 'function', 'method', 'class', 'interface', 'entity',
  'entities', 'symbol', 'define', 'defined', 'definition', 'file', 'files',
  'help', 'with', 'from', 'as', 'be', 'been', 'had', 'has', 'have', 'there',
  'their', 'them', 'they', 'we', 'at', 'so', 'if', 'then', 'than', 'too',
]);

export class QaService {
  private deadCodeCache: { dead: Set<string>; exportedButUnused: Set<string> } | null = null;

  constructor(
    private entityRepo: EntityRepository,
    private relationshipRepo: RelationshipRepository,
    private commitRepo: CommitRepository,
    private graphClient: GraphClient,
    private pool: Pool
  ) {}

  async ask(question: string): Promise<QaAnswer> {
    const intent = this.classifyIntent(question);
    const entity = await this.findEntity(question);
    const evidence: Array<{ type: string; description: string }> = [];

    if (!entity) {
      const results = await this.entityRepo.search(this.stripQuestion(question));
      const answer = results.length
        ? `No exact match found, but here are similar entities: ${results
            .slice(0, 10)
            .map(r => r.name)
            .join(', ')}`
        : `Could not find an entity matching "${question}".`;
      return {
        question,
        intent: 'search',
        answer,
        evidence: evidence.length ? evidence : [{ type: 'search', description: 'No matches found' }],
      };
    }

    evidence.push({
      type: 'entity',
      description: `${entity.name} (${entity.type}) at ${entity.filePath}:${entity.startLine}-${entity.endLine} confidence=${entity.confidence}`,
    });

    let answer: string;
    switch (intent) {
      case 'dependencies': {
        const deps = await this.graphClient.findDependencies(entity.stableId);
        const depEntities = deps.map(d => d.entity);
        answer = depEntities.length
          ? `${entity.name} depends on: ${depEntities.map(d => d.name).join(', ')}`
          : `${entity.name} has no known dependencies.`;
        evidence.push({
          type: 'relationships',
          description: `Found ${deps.length} outbound edges from ${entity.name}`,
        });
        break;
      }
      case 'dependents': {
        const deps = await this.graphClient.findDependents(entity.stableId);
        const depEntities = deps.map(d => d.entity);
        answer = depEntities.length
          ? `${entity.name} is used by: ${depEntities.map(d => `${d.name} (${d.filePath})`).join(', ')}`
          : `${entity.name} has no dependents.`;
        evidence.push({
          type: 'relationships',
          description: `Found ${deps.length} inbound edges to ${entity.name}`,
        });
        break;
      }
      case 'location': {
        answer = `${entity.name} is defined in ${entity.filePath} at lines ${entity.startLine}-${entity.endLine}.`;
        break;
      }
      case 'ownership': {
        // Prefer the exact file named in the question over the generic entity match
        const fileFromQuestion = await this.findFileFromQuestion(question);
        const filePath = fileFromQuestion?.filePath ?? entity.filePath;
        const ownership = await this.queryOwnership(filePath);
        answer = ownership
          ? `${fileFromQuestion?.name ?? entity.name} (${filePath}) is primarily owned by ${ownership.owner} (${ownership.commits} commits).`
          : `${fileFromQuestion?.name ?? entity.name} has no commit ownership data yet.`;
        evidence.push({
          type: 'ownership',
          description: ownership
            ? `Dominant author for ${filePath}: ${ownership.owner} (${ownership.commits} commits)`
            : 'No file_changes rows found for this file',
        });
        break;
      }
      case 'deadcode': {
        const report = await this.getDeadCode();
        if (report.dead.has(entity.stableId)) {
          answer = `${entity.name} is dead code (never reached from an entrypoint or test root).`;
        } else if (report.exportedButUnused.has(entity.stableId)) {
          answer = `${entity.name} is exported but not referenced from any reachable root.`;
        } else {
          answer = `${entity.name} appears to be reachable (not dead code).`;
        }
        evidence.push({ type: 'reachability', description: 'Analyzed over resolved relationship edges' });
        break;
      }
      case 'tests': {
        const deps = await this.graphClient.findDependents(entity.stableId);
        const tests = deps.map(d => d.entity).filter(e => e.isTest);
        answer = tests.length
          ? `${entity.name} is covered by tests: ${tests.map(t => t.name).join(', ')}`
          : `No test entities reference ${entity.name}.`;
        break;
      }
      case 'info':
      default: {
        const parts = [
          `${entity.name} is a ${entity.type} in ${entity.filePath} (lines ${entity.startLine}-${entity.endLine}).`,
        ];
        if (entity.purpose) parts.push(`Purpose: ${entity.purpose}`);
        if (entity.responsibility) parts.push(`Responsibility: ${entity.responsibility}`);
        if (entity.domain) parts.push(`Domain: ${entity.domain}`);
        if (entity.architecturalRole) parts.push(`Role: ${entity.architecturalRole}`);
        if (entity.isTest) parts.push('Marked as a test entity.');
        if (entity.confidence !== undefined) parts.push(`Extraction confidence: ${entity.confidence}`);
        answer = parts.join('\n');
        break;
      }
    }

    return { question, intent, entity, answer, evidence };
  }

  private classifyIntent(question: string): string {
    const q = question.toLowerCase();
    if (/who (calls|uses|references|invokes)|dependents of|impact of|what uses|who depends on/.test(q)) {
      return 'dependents';
    }
    if (/depend(en|s|encies)? on|imports? of|what (does|do).* (import|use|depend|call)/.test(q)) {
      return 'dependencies';
    }
    if (/where (is|can|do|does)/.test(q)) return 'location';
    if (/who (owns|wrote|writes|maintains)|owner of|owned by/.test(q)) return 'ownership';
    if (/dead code|unused|not used|never used/.test(q)) return 'deadcode';
    if (/test(s|ing)? (cover|for|around)|what tests|covered by/.test(q)) return 'tests';
    if (/what is|what does|describe|tell me about|what's|whats/.test(q)) return 'info';
    return 'info';
  }

  private stripQuestion(question: string): string {
    return question
      .toLowerCase()
      .replace(/[^a-z0-9_ ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOP_WORDS.has(w))
      .slice(0, 3)
      .join(' ');
  }

  private async findEntity(question: string): Promise<Entity | null> {
    const words = (question.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])
      .map(w => w.replace(/^'|'$/g, ''))
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w.toLowerCase()));

    for (const word of words.slice(0, 6)) {
      const results = await this.entityRepo.search(word);
      const exact = results.find(r => r.name === word);
      if (exact) return exact;
      if (results.length > 0) return results[0];
    }
    return null;
  }

  private async findFileFromQuestion(question: string): Promise<Entity | null> {
    const tokens = question.match(/[A-Za-z0-9_][\w.\/\\-]*\.(ts|tsx|js|jsx|py|json|css|html|md|go|rs|java|sql)/gi) || [];
    for (const token of tokens) {
      const normalized = token.replace(/\\/g, '/');
      const candidates = await this.entityRepo.search(token.replace(/[\\/.]/g, ' ').trim().split(/\s+/)[0]);
      const file = candidates.find(
        c => c.type === 'File' && c.filePath.replace(/\\/g, '/').toLowerCase().endsWith(normalized.toLowerCase())
      );
      if (file) return file;
    }
    return null;
  }

  private async queryOwnership(filePath: string): Promise<{ owner: string; commits: number } | null> {
    // file paths in file_changes use forward slashes; normalize for matching
    const normalized = filePath.replace(/\\/g, '/');
    const result = await this.pool.query(
      `SELECT (ARRAY_AGG(author ORDER BY cnt DESC))[1] AS owner, MAX(cnt) AS commits
       FROM (
         SELECT c.author, COUNT(*) AS cnt
         FROM file_changes f
         JOIN commits c ON c.hash = f.commit_hash
         WHERE f.file_path = $1
         GROUP BY c.author
       ) sub`,
      [normalized]
    );
    const row = result.rows[0];
    if (!row || !row.owner) return null;
    return { owner: row.owner, commits: parseInt(row.commits) };
  }

  private async getDeadCode(): Promise<{ dead: Set<string>; exportedButUnused: Set<string> }> {
    if (this.deadCodeCache) return this.deadCodeCache;

    const entities: Entity[] = [];
    const limit = 10000;
    let offset = 0;
    while (true) {
      const batch = await this.entityRepo.findAll(limit, offset);
      entities.push(...batch);
      if (batch.length < limit) break;
      offset += limit;
    }

    const relationships: Relationship[] = [];
    for (const type of [RelationshipType.CALLS, RelationshipType.REFERENCES, RelationshipType.IMPORTS, RelationshipType.EXTENDS, RelationshipType.IMPLEMENTS, RelationshipType.HANDLES]) {
      relationships.push(...(await this.relationshipRepo.findByType(type)));
    }

    const report = detectDeadCode(entities, relationships);
    this.deadCodeCache = {
      dead: new Set(report.deadCode.map(i => i.entity.stableId)),
      exportedButUnused: new Set(report.exportedButUnused.map(i => i.entity.stableId)),
    };
    return this.deadCodeCache;
  }
}
