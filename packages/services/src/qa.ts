import { EntityRepository, RelationshipRepository, CommitRepository, TraversalService } from '@repo-memory/storage';
import { Entity, Relationship, RelationshipType } from '@repo-memory/shared';
import { detectDeadCode, ChangeAnalyzer } from '@repo-memory/analysis';
import { makeChangeAnalyzer } from './change-factory.js';
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
  private deadCodeCache: { dead: Set<string>; exportedButUnused: Set<string>; computedAt: number } | null = null;
  private changeAnalyzer: ChangeAnalyzer | null = null;

  constructor(
    private entityRepo: EntityRepository,
    private relationshipRepo: RelationshipRepository,
    private commitRepo: CommitRepository,
    private traversal: TraversalService,
    private pool: Pool,
    private workspace: boolean = false,
    private repoPath: string = ''
  ) {}

  private get graphScope(): string | undefined {
    return this.workspace ? undefined : this.repoPath;
  }

  // Drop computed caches so the next question re-derives them from fresh data.
  // Called by the server after data-changing operations (verify/repair jobs).
  invalidateCache(): void {
    this.deadCodeCache = null;
    this.changeAnalyzer = null;
  }

  // Direct + transitive dependents of an entity with affected files and a
  // risk score. Shared by QA answers, the API impact endpoint, and the MCP
  // impact tool so all three agree.
  async computeImpact(stableId: string): Promise<{
    directImpact: Entity[];
    indirectImpact: Entity[];
    affectedFiles: string[];
    riskScore: number;
  }> {
    const direct = await this.traversal.findDependents(stableId, this.graphScope);
    const indirect = await this.traversal.findTransitiveDependents(stableId, 3, this.graphScope);
    const affectedFiles = new Set<string>();
    direct.forEach(d => affectedFiles.add(d.entity.filePath));
    indirect.forEach(e => affectedFiles.add(e.filePath));
    return {
      directImpact: direct.map(d => d.entity),
      indirectImpact: indirect,
      affectedFiles: [...affectedFiles],
      riskScore: Math.min(1.0, direct.length * 0.1 + indirect.length * 0.05),
    };
  }

  async ask(question: string): Promise<QaAnswer> {
    if (this.workspace) {
      const ambiguous = await this.workspaceAmbiguityAnswer(question);
      if (ambiguous) return ambiguous;
    }

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
      if (this.workspace) {
        const ambiguous = await this.workspaceAmbiguityAnswer(fragment);
        if (ambiguous) {
          parts.push(ambiguous.answer);
          continue;
        }
      }
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
    if (intent === 'churn' || intent === 'drift') {
      return this.answerRepoLevel(question, intent, evidence);
    }

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
        const deps = await this.traversal.findDependencies(entity.stableId, this.graphScope);
        const depEntities = deps.map(d => d.entity);
        if (entity.type === 'File') {
          const imports = deps.filter(d => d.relationship.type === RelationshipType.IMPORTS);
          const symbols = deps.filter(d => d.relationship.type !== RelationshipType.IMPORTS);
          answer = `${entity.name} imports ${imports.length} module(s) and references ${symbols.length} symbol(s).`;
          if (imports.length) answer += `\nImports: ${imports.map(d => d.entity.name).join(', ')}`;
          if (symbols.length) answer += `\nSymbols: ${symbols.slice(0, 10).map(d => d.entity.name).join(', ')}`;
        } else {
          answer = depEntities.length
            ? `${entity.name} depends on: ${depEntities.map(d => this.workspace ? `${d.name} (${this.entityPath(d)})` : d.name).join(', ')}`
            : `${entity.name} has no known dependencies.`;
        }
        evidence.push({
          type: 'relationships',
          description: `Found ${deps.length} outbound edges from ${entity.name}`,
        });
        break;
      }
      case 'dependents': {
        const deps = await this.traversal.findDependents(entity.stableId, this.graphScope);
        const depEntities = deps.map(d => d.entity);
        answer = depEntities.length
          ? `${entity.name} is used by: ${depEntities.map(d => `${d.name} (${this.entityPath(d)})`).join(', ')}`
          : `${entity.name} has no dependents.`;
        evidence.push({
          type: 'relationships',
          description: `Found ${deps.length} inbound edges to ${entity.name}`,
        });
        break;
      }
      case 'location': {
        answer = `${entity.name} is defined in ${this.entityPath(entity)} at lines ${entity.startLine}-${entity.endLine}.`;
        break;
      }
      case 'ownership': {
        // Prefer the exact file named in the question over the generic entity match
        const fileFromQuestion = await this.findFileFromQuestion(question);
        const filePath = fileFromQuestion?.filePath ?? entity.filePath;
        const displayPath = this.workspace && entity.repoPath ? `${entity.repoPath}:${filePath}` : filePath;
        const ownership = await this.queryOwnership(filePath);
        answer = ownership
          ? `${fileFromQuestion?.name ?? entity.name} (${displayPath}) is primarily owned by ${ownership.owner} (${ownership.commits} commits).`
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
        const impact = await this.computeImpact(entity.stableId);
        const risk = impact.riskScore;
        answer =
          `Changing ${entity.name} directly affects ${impact.directImpact.length} entities and ` +
          `${impact.indirectImpact.length} transitive dependents across ${impact.affectedFiles.length} files. ` +
          `Risk score: ${Math.round(risk * 100)}/100.`;
        if (impact.affectedFiles.length) {
          answer += `\nAffected files: ${impact.affectedFiles.slice(0, 10).join(', ')}`;
        }
        evidence.push({
          type: 'impact',
          description: `Direct=${impact.directImpact.length}, transitive=${impact.indirectImpact.length}, files=${impact.affectedFiles.length}, risk=${risk.toFixed(2)}`,
        });
        break;
      }
      case 'path': {
        const target = await this.findSecondEntity(question, entity);
        if (!target) {
          answer = `Could not find a second entity in "${question}" to trace a path to.`;
          break;
        }
        const path = await this.traversal.findShortestPath(entity.stableId, target.stableId, 5);
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
          ? `Recent changes to ${entity.name} (${this.entityPath(entity)}):\n` +
            commits
              .slice(0, 10)
              .map(c => `  ${c.hash.slice(0, 7)} ${c.date.toISOString().slice(0, 10)} ${c.author}: ${c.message}`)
              .join('\n')
          : `No commit history found for ${entity.name}.`;
        evidence.push({ type: 'commits', description: `Found ${commits.length} commits touching ${entity.filePath}` });
        break;
      }
      case 'file-deps': {
        const deps = await this.traversal.findDependencies(entity.stableId, this.graphScope);
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
          `${entity.name} is a ${entity.type} in ${this.entityPath(entity)} (lines ${entity.startLine}-${entity.endLine}).`,
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
    const candidates = await this.traversal.findDependents(entity.stableId, this.graphScope);
    let tests = candidates.map(d => d.entity).filter(e => e.isTest);

    // Endpoints: also include tests that cover their handlers
    if (tests.length === 0 && entity.type === 'ApiEndpoint') {
      const handlerRels = await this.relationshipRepo.findBySourceId(entity.stableId);
      for (const rel of handlerRels.filter(r => r.type === RelationshipType.HANDLES)) {
        const handler = await this.entityRepo.findByStableId(rel.targetId);
        if (handler) {
          const handlerDeps = await this.traversal.findDependents(handler.stableId, this.graphScope);
          tests = handlerDeps.map(d => d.entity).filter(e => e.isTest);
          if (tests.length) break;
        }
      }
    }

    // Fallback: test entities that depend on the entity's file (import the module)
    if (tests.length === 0) {
      const fileEntity = (await this.entityRepo.findByFilePath(entity.filePath)).find(e => e.type === 'File');
      if (fileEntity) {
        const fileDeps = await this.traversal.findDependents(fileEntity.stableId, this.graphScope);
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
    if (/which files? (change|churn)|most (changed|unstable|churned)|what files? change|churn\b|changing the most/.test(q)) {
      return 'churn';
    }
    if (/drift|drifting|diverge|out of sync|decay/.test(q)) {
      return 'drift';
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

  // --- Workspace resolution -------------------------------------------------

  private async resolveCandidates(question: string): Promise<Entity[]> {
    const endpoints = await this.findEndpointCandidates(question);
    if (endpoints.length) return endpoints;
    const files = await this.findFileCandidates(question);
    if (files.length) return files;
    return this.findEntityCandidates(question);
  }

  private async workspaceAmbiguityAnswer(question: string): Promise<QaAnswer | null> {
    const candidates = await this.resolveCandidates(question);
    if (!candidates.length) return null;

    const repos = new Set(candidates.map(c => c.repoPath || ''));
    if (repos.size <= 1) return null;

    const byRepo = new Map<string, Set<string>>();
    for (const c of candidates) {
      const key = c.repoPath || '(unknown)';
      if (!byRepo.has(key)) byRepo.set(key, new Set());
      byRepo.get(key)!.add(c.name);
    }

    return {
      question,
      intent: 'workspace-ambiguous',
      answer:
        `Found matches across ${repos.size} repositories. Please specify which repository you mean:\n` +
        [...byRepo.entries()].map(([repo, names]) => `  - ${repo}: ${[...names].join(', ')}`).join('\n'),
      evidence: [{ type: 'workspace', description: `Candidates across ${repos.size} repos` }],
    };
  }

  private async findEndpointCandidates(question: string): Promise<Entity[]> {
    const match = question.match(/\b(?:POST|GET|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+\/[\w/:.\-_{}<>]*/i);
    if (!match) return [];
    const target = match[0].replace(/\s+/g, ' ').trim();
    const pathToken = target.split(/\s+/)[1].replace(/[/:{}<>]/g, ' ').trim().split(/\s+/)[0];
    const candidates = await this.entityRepo.search(pathToken || 'route');
    const verb = target.split(/\s+/)[0].toUpperCase();
    const exact = candidates.filter(c => c.type === 'ApiEndpoint' && c.name.toLowerCase() === target.toLowerCase());
    if (exact.length) return exact;
    return candidates.filter(
      c => c.type === 'ApiEndpoint' && c.name.toUpperCase().startsWith(verb) && c.name.includes(target.split(/\s+/)[1].split(':')[0])
    );
  }

  private async findFileCandidates(question: string): Promise<Entity[]> {
    const tokens = question.match(/[A-Za-z0-9_][\w./\\-]*\.(ts|tsx|js|jsx|py|json|css|html|md|go|rs|java|sql)/gi) || [];
    const results: Entity[] = [];
    const seen = new Set<string>();
    for (const token of tokens) {
      const normalized = token.replace(/\\/g, '/');
      const candidates = await this.entityRepo.search(token.replace(/[\\/.]/g, ' ').trim().split(/\s+/)[0]);
      for (const c of candidates) {
        if (
          c.type === 'File' && c.filePath.replace(/\\/g, '/').toLowerCase().endsWith(normalized.toLowerCase()) &&
          !seen.has(c.stableId)
        ) {
          seen.add(c.stableId);
          results.push(c);
        }
      }
    }
    return results;
  }

  private async findEntityCandidates(question: string): Promise<Entity[]> {
    const words = this.questionWords(question);
    const results: Entity[] = [];
    const seen = new Set<string>();
    for (const word of words.slice(0, 6)) {
      const matches = await this.entityRepo.search(word);
      for (const m of matches) {
        if (!seen.has(m.stableId)) {
          seen.add(m.stableId);
          results.push(m);
        }
      }
    }
    return results;
  }

  private entityPath(entity: Entity): string {
    return this.workspace && entity.repoPath ? `${entity.repoPath}:${entity.filePath}` : entity.filePath;
  }

  private async findEndpointFromQuestion(question: string): Promise<Entity | null> {
    return (await this.findEndpointCandidates(question))[0] || null;
  }

  private async findFileFromQuestion(question: string): Promise<Entity | null> {
    return (await this.findFileCandidates(question))[0] || null;
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
    const tokens = question.match(/[A-Za-z0-9_][\w./\\-]*\.(ts|tsx|js|jsx|py|json|css|html|md|go|rs|java|sql)/gi) || [];
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

  private async queryOwnership(filePath: string): Promise<{ owner: string; commits: number } | null> {
    // file paths in file_changes use forward slashes; normalize for matching
    const normalized = filePath.replace(/\\/g, '/');
    const scope = this.workspace ? '' : this.repoPath;
    const whereRepo = scope ? 'AND f.repo_path = $2' : '';
    const params = scope ? [normalized, scope] : [normalized];
    const result = await this.pool.query(
      `SELECT (ARRAY_AGG(author ORDER BY cnt DESC))[1] AS owner, MAX(cnt) AS commits
       FROM (
         SELECT c.author, COUNT(*) AS cnt
         FROM file_changes f
         JOIN commits c ON c.hash = f.commit_hash AND c.repo_path = f.repo_path
         WHERE f.file_path = $1 ${whereRepo}
         GROUP BY c.author
       ) sub`,
      params
    );
    const row = result.rows[0];
    if (!row || !row.owner) return null;
    return { owner: row.owner, commits: parseInt(row.commits) };
  }

  private getChangeAnalyzer(): ChangeAnalyzer {
    if (!this.changeAnalyzer) {
      this.changeAnalyzer = makeChangeAnalyzer(this.pool);
    }
    return this.changeAnalyzer;
  }

  private async answerRepoLevel(
    question: string,
    intent: string,
    evidence: Array<{ type: string; description: string }>
  ): Promise<QaAnswer> {
    if (!this.repoPath) {
      return {
        question,
        intent,
        answer: 'Churn and drift are per-repository analyses. Please ask against a specific repository.',
        evidence: [{ type: 'change', description: 'Workspace-wide churn/drift is not supported' }],
      };
    }

    const analyzer = this.getChangeAnalyzer();

    if (intent === 'churn') {
      const churn = await analyzer.computeFileChurn(this.repoPath, 10);
      evidence.push({ type: 'churn', description: `Top ${churn.length} files by churn score` });
      return {
        question,
        intent,
        answer: churn.length
          ? `Most changed files:\n${churn.map(c => `  ${c.filePath} — ${c.commits} commits, +${c.additions}/-${c.deletions} (score ${c.churnScore})`).join('\n')}`
          : 'No churn data available yet (scan commit history first).',
        evidence,
      };
    }

    if (intent === 'drift') {
      const report = await analyzer.detectDrift(this.repoPath);
      evidence.push({ type: 'drift', description: `${report.signals.length} drift signal(s)` });
      return {
        question,
        intent,
        answer: report.signals.length
          ? `Architecture drift signals:\n${report.signals.map(s => `  [${s.severity}] ${s.description}`).join('\n')}`
          : 'No architecture drift signals detected.',
        evidence,
      };
    }

    return { question, intent, answer: '', evidence };
  }

  // Dead-code computation is expensive, so it's cached; a short TTL bounds how
  // stale the answer can be between scans (the server also invalidates on
  // verify/repair jobs).
  private static readonly DEAD_CODE_CACHE_TTL_MS = 60_000;

  private async getDeadCode(): Promise<{ dead: Set<string>; exportedButUnused: Set<string> }> {
    if (this.deadCodeCache && Date.now() - this.deadCodeCache.computedAt < QaService.DEAD_CODE_CACHE_TTL_MS) {
      return this.deadCodeCache;
    }

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
      computedAt: Date.now(),
    };
    return this.deadCodeCache;
  }
}
