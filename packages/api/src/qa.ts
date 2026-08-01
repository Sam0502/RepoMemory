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
    const fragments = this.splitFragments(question);

    if (fragments.length > 1) {
      return this.askCompound(fragments);
    }

    const intent = this.classifyIntent(question);
    const entity = await this.resolveEntity(question);
    const evidence: Array<{ type: string; description: string }> = [];
    const result = await this.answerIntent(question, intent, entity, evidence);

    if (!entity) return result;
    return { question, intent, entity, answer: result.answer, evidence };
  }

  // --- Orchestration -----------------------------------------------------

  private async askCompound(fragments: string[]): Promise<QaAnswer> {
    const evidence: Array<{ type: string; description: string }> = [];
    const parts: string[] = [];
    let lastEntity: Entity | null = null;

    for (const fragment of fragments) {
      const intent = this.classifyIntent(fragment);
      let entity = await this.resolveEntity(fragment);
      if (!entity) entity = lastEntity; // inherit from previous fragment ("and who calls it")

      const result = await this.answerIntent(fragment, intent, entity, evidence);
      if (entity) lastEntity = entity;
      parts.push(result.answer);
    }

    return {
      question: fragments.join('; '),
      intent: 'compound',
      answer: parts.join('\n\n'),
      evidence,
    };
  }

  private splitFragments(question: string): string[] {
    return question
      .split(/\s*(?:;|\.\s|\band\b|\bthen\b|\balso\b)\s*/i)
      .map(s => s.trim())
      .filter(Boolean);
  }

  private async answerIntent(
    question: string,
    intent: string,
    entity: Entity | null,
    evidence: Array<{ type: string; description: string }>
  ): Promise<QaAnswer> {
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
        evidence: [{ type: 'search', description: 'No matches found' }],
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
        if (entity.type === 'File') {
          const imports = deps.filter(d => d.relationship.type === RelationshipType.IMPORTS);
          const symbols = deps.filter(d => d.relationship.type !== RelationshipType.IMPORTS);
          answer = `${entity.name} imports ${imports.length} module(s) and references ${symbols.length} symbol(s).`;
          if (imports.length) answer += `\nImports: ${imports.map(d => d.entity.name).join(', ')}`;
          if (symbols.length) answer += `\nSymbols: ${symbols.slice(0, 10).map(d => d.entity.name).join(', ')}`;
        } else {
          answer = depEntities.length
            ? `${entity.name} depends on: ${depEntities.map(d => d.name).join(', ')}`
            : `${entity.name} has no known dependencies.`;
        }
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
        const tests = await this.findTestsFor(entity);
        answer = tests.length
          ? `${entity.name} is covered by tests: ${tests.map(t => t.name).join(', ')}`
          : `No test entities reference ${entity.name}.`;
        break;
      }
      case 'impact': {
        const direct = await this.graphClient.findDependents(entity.stableId);
        const indirect = await this.graphClient.findTransitiveDependents(entity.stableId, 3);
        const affectedFiles = new Set<string>();
        direct.forEach(d => affectedFiles.add(d.entity.filePath));
        indirect.forEach(e => affectedFiles.add(e.filePath));
        const risk = Math.min(1.0, direct.length * 0.1 + indirect.length * 0.05);
        answer =
          `Changing ${entity.name} directly affects ${direct.length} entities and ` +
          `${indirect.length} transitive dependents across ${affectedFiles.size} files. ` +
          `Risk score: ${Math.round(risk * 100)}/100.`;
        if (affectedFiles.size) {
          answer += `\nAffected files: ${Array.from(affectedFiles).slice(0, 10).join(', ')}`;
        }
        evidence.push({
          type: 'impact',
          description: `Direct=${direct.length}, transitive=${indirect.length}, files=${affectedFiles.size}, risk=${risk.toFixed(2)}`,
        });
        break;
      }
      case 'path': {
        const target = await this.findSecondEntity(question, entity);
        if (!target) {
          answer = `Could not find a second entity in "${question}" to trace a path to.`;
          break;
        }
        const path = await this.graphClient.findShortestPath(entity.stableId, target.stableId, 5);
        if (!path) {
          answer = `No path found between ${entity.name} and ${target.name} within 5 hops.`;
        } else {
          answer = this.formatPath(entity.name, target.name, path);
          evidence.push({
            type: 'path',
            description: `Shortest path: ${path.nodes.map(n => n.name).join(' -> ')} (${path.nodes.length} nodes)`,
          });
        }
        break;
      }
      case 'changelog': {
        const commits = await this.commitRepo.findCommitsForFile(entity.filePath);
        answer = commits.length
          ? `Recent changes to ${entity.name} (${entity.filePath}):\n` +
            commits
              .slice(0, 10)
              .map(c => `  ${c.hash.slice(0, 7)} ${c.date.toISOString().slice(0, 10)} ${c.author}: ${c.message}`)
              .join('\n')
          : `No commit history found for ${entity.name}.`;
        evidence.push({ type: 'commits', description: `Found ${commits.length} commits touching ${entity.filePath}` });
        break;
      }
      case 'file-deps': {
        const deps = await this.graphClient.findDependencies(entity.stableId);
        const imports = deps.filter(d => d.relationship.type === RelationshipType.IMPORTS);
        const calls = deps.filter(d => d.relationship.type !== RelationshipType.IMPORTS);
        answer = `${entity.name} imports ${imports.length} module(s) and references ${calls.length} symbol(s).`;
        if (imports.length) answer += `\nImports: ${imports.map(d => d.entity.name).join(', ')}`;
        if (calls.length) answer += `\nSymbols: ${calls.slice(0, 10).map(d => d.entity.name).join(', ')}`;
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

  private async findTestsFor(entity: Entity): Promise<Entity[]> {
    const candidates = await this.graphClient.findDependents(entity.stableId);
    let tests = candidates.map(d => d.entity).filter(e => e.isTest);

    // Endpoints: also include tests that cover their handlers
    if (tests.length === 0 && entity.type === 'ApiEndpoint') {
      const handlerRels = await this.relationshipRepo.findBySourceId(entity.stableId);
      for (const rel of handlerRels.filter(r => r.type === RelationshipType.HANDLES)) {
        const handler = await this.entityRepo.findByStableId(rel.targetId);
        if (handler) {
          const handlerDeps = await this.graphClient.findDependents(handler.stableId);
          tests = handlerDeps.map(d => d.entity).filter(e => e.isTest);
          if (tests.length) break;
        }
      }
    }

    // Fallback: test entities that depend on the entity's file (import the module)
    if (tests.length === 0) {
      const fileEntity = (await this.entityRepo.findByFilePath(entity.filePath)).find(e => e.type === 'File');
      if (fileEntity) {
        const fileDeps = await this.graphClient.findDependents(fileEntity.stableId);
        tests = fileDeps.map(d => d.entity).filter(e => e.isTest);
      }
    }
    return tests;
  }

  private formatPath(
    fromName: string,
    toName: string,
    path: { nodes: Entity[]; relationships: Array<{ type: string; direction: 'out' | 'in' }> }
  ): string {
    const parts: string[] = [fromName];
    for (let i = 0; i < path.relationships.length; i++) {
      const rel = path.relationships[i];
      const nextName = path.nodes[i + 1]?.name ?? '?';
      parts.push(`${rel.direction === 'out' ? '-->' : '<--'} [${rel.type}] ${nextName}`);
    }
    return `Path from ${fromName} to ${toName}: ${parts.join(' ')}`;
  }

  // --- Intent classification ----------------------------------------------

  private classifyIntent(question: string): string {
    const q = question.toLowerCase();
    if (/impact|affected by|what breaks|what would break|breaking change|downstream/.test(q)) {
      return 'impact';
    }
    if (/who (calls|uses|references|invokes|imports)|dependents of|what uses|who depends on|what.*(files|modules).*imports/.test(q)) {
      return 'dependents';
    }
    if (/depend(en|s|encies)? on|imports? of|imports\b|what (does|do).* (import|use|depend|call)/.test(q)) {
      return 'dependencies';
    }
    if (/path (from|between|to)|relation between|how (does|is|do).*(relate|connect|link|depend|reach)/.test(q)) {
      return 'path';
    }
    if (/changed (recently|in|since)|recent (changes|commits|history)|history of|last changed|what changed/.test(q)) {
      return 'changelog';
    }
    if (/where (is|can|do|does)/.test(q)) return 'location';
    if (/who (owns|wrote|writes|maintains)|owner of|owned by/.test(q)) return 'ownership';
    if (/dead code|unused|not used|never used/.test(q)) return 'deadcode';
    if (/test(s|ing)? (cover|for|around)|what tests|covered by|who tests/.test(q)) return 'tests';
    if (/(does|what does|what).*(file|module|package).*(depend|import|use)/.test(q)) return 'file-deps';
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

  // --- Entity resolution --------------------------------------------------

  private async resolveEntity(question: string): Promise<Entity | null> {
    const endpointEntity = await this.findEndpointFromQuestion(question);
    if (endpointEntity) return endpointEntity;
    const fileEntity = await this.findFileFromQuestion(question);
    if (fileEntity) return fileEntity;
    return this.findEntity(question);
  }

  private async findEndpointFromQuestion(question: string): Promise<Entity | null> {
    const match = question.match(/\b(?:POST|GET|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\/[\w\/:.\-_{}<>]*/i);
    if (!match) return null;
    const target = match[0].replace(/\s+/g, ' ').trim();
    const pathToken = target.split(/\s+/)[1].replace(/[\/:{}<>]/g, ' ').trim().split(/\s+/)[0];
    const candidates = await this.entityRepo.search(pathToken || 'route');
    const verb = target.split(/\s+/)[0].toUpperCase();
    return (
      candidates.find(c => c.type === 'ApiEndpoint' && c.name.toLowerCase() === target.toLowerCase()) ??
      candidates.find(c => c.type === 'ApiEndpoint' && c.name.toUpperCase().startsWith(verb) && c.name.includes(target.split(/\s+/)[1].split(':')[0]))
    ) || null;
  }

  private async findEntity(question: string): Promise<Entity | null> {
    const words = this.questionWords(question);
    for (const word of words.slice(0, 6)) {
      const results = await this.entityRepo.search(word);
      const exact = results.find(r => r.name === word);
      if (exact) return exact;
      if (results.length > 0) return results[0];
    }
    return null;
  }

  private async findSecondEntity(question: string, first: Entity): Promise<Entity | null> {
    const tokens = question.match(/[A-Za-z0-9_][\w.\/\\-]*\.(ts|tsx|js|jsx|py|json|css|html|md|go|rs|java|sql)/gi) || [];
    for (const token of tokens) {
      const normalized = token.replace(/\\/g, '/');
      const candidates = await this.entityRepo.search(token.replace(/[\\/.]/g, ' ').trim().split(/\s+/)[0]);
      for (const c of candidates) {
        if (
          c.type === 'File' && c.stableId !== first.stableId &&
          c.filePath.replace(/\\/g, '/').toLowerCase().endsWith(normalized.toLowerCase())
        ) {
          return c;
        }
      }
    }

    const endpointEntity = await this.findEndpointFromQuestion(question);
    if (endpointEntity && endpointEntity.stableId !== first.stableId) return endpointEntity;

    const generic = new Set(['id', 'get', 'set', 'data', 'index', 'list', 'post', 'put', 'name', 'type']);
    const words = this.questionWords(question).reverse();
    const firstTokens = new Set(first.name.toLowerCase().split(/[^a-z0-9_]+/));
    for (const word of words.slice(0, 8)) {
      if (generic.has(word.toLowerCase())) continue;
      if (firstTokens.has(word.toLowerCase())) continue;
      const results = await this.entityRepo.search(word);
      const candidates = results.filter(r => r.stableId !== first.stableId);
      const exact = candidates.find(r => r.name === word);
      if (exact) return exact;
      if (candidates.length > 0) return candidates[0];
    }
    return null;
  }

  private questionWords(question: string): string[] {
    return (question.match(/[A-Za-z_][A-Za-z0-9_]*/g) || [])
      .map(w => w.replace(/^'|'$/g, ''))
      .filter(w => w.length >= 2 && !STOP_WORDS.has(w.toLowerCase()));
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
