import {
  ContextPack,
  TaskContextPack,
  TaskContextRisk,
  Entity,
  Relationship,
  RelationshipType,
  Commit,
} from '@repo-memory/shared';
import { EntityRepository, CommitRepository, RelationshipRepository } from '@repo-memory/storage';
import { GraphClient } from '@repo-memory/graph';
import {
  ChangeAnalyzer,
  streamBoundaries,
  parseDomainConfig,
  resolveBatchSize,
} from '@repo-memory/analysis';
import type { EmbeddingProvider, DomainConfig, FileChurn } from '@repo-memory/analysis';
import { readFileSync } from 'fs';
import { join } from 'path';

// Optional runtime collaborators for task packs. `embedder` enables semantic
// seeding, `changeAnalyzer` (built with a lazy per-repo provider) supplies
// churn/risk signals, `relationshipRepo` enables boundary reporting, and
// `repoPath` scopes file reads (boundaries.json) and churn queries.
export interface ContextPackBuilderOptions {
  embedder?: EmbeddingProvider;
  changeAnalyzer?: ChangeAnalyzer;
  relationshipRepo?: RelationshipRepository;
  repoPath?: string;
}

const DEFAULT_TOKEN_BUDGET = 4000;
const DEFAULT_MAX_FOCAL = 10;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function dedupeRels(rels: Relationship[]): Relationship[] {
  const seen = new Set<string>();
  const out: Relationship[] = [];
  for (const rel of rels) {
    const key = `${rel.sourceId}|${rel.targetId}|${rel.type}|${rel.filePath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rel);
  }
  return out;
}

export class ContextPackBuilder {
  constructor(
    private entityRepo: EntityRepository,
    private commitRepo: CommitRepository,
    private graphClient: GraphClient,
    private options: ContextPackBuilderOptions = {}
  ) {}

  async build(stableId: string, tokenBudget?: number): Promise<ContextPack | null> {
    const entity = await this.entityRepo.findByStableId(stableId);
    if (!entity) return null;

    const deps = await this.graphClient.findDependencies(stableId);
    const dependents = await this.graphClient.findDependents(stableId);
    const similar = await this.entityRepo.findSimilar(stableId, 5, 0.3);
    const commits = await this.commitRepo.findRecent(10);

    const pack: ContextPack = {
      entity,
      dependencies: deps.map(d => d.entity),
      dependents: dependents.map(d => d.entity),
      recentChanges: commits.filter(c =>
        c.filesChanged.some(f => f === entity.filePath) && c.repoPath === entity.repoPath
      ),
      similarEntities: similar,
      metadata: {
        packageName: this.inferPackage(entity.filePath),
        entityCount: 1 + deps.length + dependents.length + similar.length,
        dependencyDepth: 1,
      },
      tokenCount: 0,
    };

    pack.tokenCount = this.estimateTokens(pack);

    if (tokenBudget && pack.tokenCount > tokenBudget) {
      return this.trim(pack, tokenBudget);
    }

    return pack;
  }

  // Builds a task-level pack from a natural-language description (or a stable
  // ID / file path). Seeds focal entities via hybrid keyword + semantic search,
  // expands one graph hop, then attaches per-file commit/risk and boundary
  // signals, trimmed to a token budget.
  async buildTaskContext(
    task: string,
    opts: { tokenBudget?: number; maxFocal?: number } = {}
  ): Promise<TaskContextPack | null> {
    const tokenBudget = opts.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
    const maxFocal = opts.maxFocal ?? DEFAULT_MAX_FOCAL;
    const repoPath = this.options.repoPath ?? '';
    const query = task.trim();
    if (!query) return null;

    const seeded: Entity[] = [];
    const seenSeed = new Set<string>();
    const addSeed = (e: Entity | null | undefined): void => {
      if (e && !seenSeed.has(e.stableId)) {
        seenSeed.add(e.stableId);
        seeded.push(e);
      }
    };

    // 1. Direct resolve: a stable ID or a file path beats fuzzy matching.
    const direct = await this.entityRepo.findByStableId(query);
    if (direct) {
      addSeed(direct);
    } else if (/[/\\]/.test(query) || /\.[jt]sx?$/.test(query)) {
      for (const e of await this.entityRepo.findByFilePath(query)) addSeed(e);
    }

    // 2. Keyword search.
    for (const e of await this.entityRepo.search(query)) addSeed(e);

    // 3. Semantic search (best-effort; falls back to keyword-only).
    let strategy = 'keyword';
    if (this.options.embedder) {
      try {
        const vector = await this.options.embedder.embed(query);
        for (const e of await this.entityRepo.findByEmbedding(vector, 20, 0.35)) addSeed(e);
        strategy = 'keyword+semantic';
      } catch {
        strategy = 'keyword';
      }
    }

    if (seeded.length === 0) return null;
    const focalEntities = seeded.slice(0, maxFocal);

    // Expand one graph hop around the focal entities (their repo scopes edges).
    const expanded: Entity[] = [];
    const rels: Relationship[] = [];
    const seenExpanded = new Set<string>();
    for (const focal of focalEntities) {
      if (!seenExpanded.has(focal.stableId)) {
        seenExpanded.add(focal.stableId);
        expanded.push(focal);
      }
      const scope = focal.repoPath ?? repoPath;
      for (const d of await this.graphClient.findDependencies(focal.stableId, scope)) {
        rels.push(d.relationship);
        if (!seenExpanded.has(d.entity.stableId)) {
          seenExpanded.add(d.entity.stableId);
          expanded.push(d.entity);
        }
      }
      for (const d of await this.graphClient.findDependents(focal.stableId, scope)) {
        rels.push(d.relationship);
        if (!seenExpanded.has(d.entity.stableId)) {
          seenExpanded.add(d.entity.stableId);
          expanded.push(d.entity);
        }
      }
    }

    // Group expanded entities by file; focal files sort first.
    const fileOrder = new Map<string, number>();
    focalEntities.forEach((e, i) => {
      const key = normalizePath(e.filePath);
      if (!fileOrder.has(key)) fileOrder.set(key, i);
    });
    const entitiesByFile = new Map<string, Entity[]>();
    for (const e of expanded) {
      const key = normalizePath(e.filePath);
      const list = entitiesByFile.get(key);
      if (list) list.push(e);
      else entitiesByFile.set(key, [e]);
    }

    const files = [...entitiesByFile.entries()]
      .sort((a, b) => (fileOrder.get(a[0]) ?? 0) - (fileOrder.get(b[0]) ?? 0))
      .slice(0, maxFocal)
      .map(([filePath, entities]) => ({
        filePath,
        domain: entities.find(e => e.domain)?.domain,
        entityCount: entities.length,
      }));

    const focalFiles = files.map(f => f.filePath);

    // Per-file commit history (authoritative count + recency).
    const commitsByFile = new Map<string, Commit[]>();
    for (const file of focalFiles) {
      commitsByFile.set(file, await this.commitRepo.findCommitsForFile(file, 50));
    }

    // Churn enrichment when a ChangeAnalyzer is provided.
    const churnByFile = new Map<string, FileChurn>();
    if (this.options.changeAnalyzer) {
      for (const row of await this.options.changeAnalyzer.computeFileChurn(repoPath, 100000)) {
        churnByFile.set(normalizePath(row.filePath), row);
      }
    }

    // Risk: per-file commit count / churn / staleness + focal-entity staleness.
    const now = new Date();
    const riskFiles: TaskContextRisk['files'] = [];
    for (const file of focalFiles) {
      const commits = commitsByFile.get(file) ?? [];
      const churn = churnByFile.get(file);
      const lastChanged = commits[0]?.date ?? churn?.lastChanged ?? null;
      const daysSinceLastChange = lastChanged
        ? Math.max(0, Math.round((now.getTime() - lastChanged.getTime()) / 86400000))
        : null;
      const commitCount = churn?.commits ?? commits.length;
      const churnScore = churn?.churnScore ?? commitCount;
      const stalenessPenalty = daysSinceLastChange !== null && daysSinceLastChange > 180 ? 20 : 0;
      riskFiles.push({
        filePath: file,
        commitCount,
        churnScore,
        daysSinceLastChange,
        riskScore: Math.min(100, commitCount * 5 + stalenessPenalty),
      });
    }

    const entityStaleness: TaskContextRisk['entityStaleness'] = focalEntities.map(e => {
      const churn = churnByFile.get(normalizePath(e.filePath));
      const commits = commitsByFile.get(normalizePath(e.filePath)) ?? [];
      return {
        stableId: e.stableId,
        name: e.name,
        filePath: e.filePath,
        commitCount: churn?.commits ?? commits.length,
        stalenessDays: churn?.daysSinceLastChange ?? null,
      };
    });

    // Boundaries: cross-domain edges touching focal files (best-effort).
    const domains = [...new Set(focalEntities.map(e => e.domain).filter((d): d is string => Boolean(d)))];
    const violations: TaskContextPack['boundaries']['violations'] = [];
    if (this.options.relationshipRepo) {
      let domainConfig: DomainConfig | undefined;
      try {
        domainConfig = parseDomainConfig(readFileSync(join(repoPath, '.repomemory', 'boundaries.json'), 'utf-8'));
      } catch {
        domainConfig = undefined;
      }
      const report = await streamBoundaries(
        { page: (offset, limit) => this.entityRepo.findAll(limit, offset) },
        { page: (offset, limit) => this.options.relationshipRepo!.findByTypesPaged([...BOUNDARY_TYPES], limit, offset) },
        domainConfig,
        { batchSize: resolveBatchSize() }
      );
      const focalFileSet = new Set(focalFiles.map(normalizePath));
      for (const v of report.violations) {
        if (
          focalFileSet.has(normalizePath(v.source.filePath)) ||
          focalFileSet.has(normalizePath(v.target.filePath))
        ) {
          violations.push({
            source: v.source.filePath,
            target: v.target.filePath,
            type: v.relationshipType,
            message: `${v.source.domain} -> ${v.target.domain}`,
          });
        }
      }
    }

    const recentChanges = [...dedupeCommits(commitsByFile)].sort((a, b) => b.date.getTime() - a.date.getTime());

    const pack: TaskContextPack = {
      task,
      repoPath: repoPath || undefined,
      focalEntities,
      files,
      relationships: dedupeRels(rels).slice(0, 200),
      recentChanges: recentChanges.slice(0, 20),
      risk: { files: riskFiles, entityStaleness },
      boundaries: { domains, violations },
      metadata: {
        entityCount: expanded.length,
        fileCount: files.length,
        relationshipCount: dedupeRels(rels).length,
        rankingStrategy: strategy,
      },
      tokenCount: 0,
    };

    pack.tokenCount = this.estimateTaskTokens(pack);
    if (pack.tokenCount > tokenBudget) {
      return this.trimTask(pack, tokenBudget);
    }
    return pack;
  }

  private inferPackage(filePath: string): string {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const pkgMatch = normalizedPath.match(/(?:packages|src)\/([^/]+)/);
    return pkgMatch ? pkgMatch[1] : 'root';
  }

  private estimateTokens(pack: ContextPack): number {
    let tokens = 0;
    tokens += JSON.stringify(pack.entity).length / 4;
    tokens += pack.dependencies.reduce((s, e) => s + JSON.stringify(e).length, 0) / 4;
    tokens += pack.dependents.reduce((s, e) => s + JSON.stringify(e).length, 0) / 4;
    tokens += pack.similarEntities.reduce((s, e) => s + JSON.stringify(e).length, 0) / 4;
    tokens += pack.recentChanges.reduce((s, c) => s + c.message.length, 0) / 4;
    return Math.round(tokens);
  }

  private estimateTaskTokens(pack: TaskContextPack): number {
    let tokens = 0;
    tokens += pack.focalEntities.reduce((s, e) => s + JSON.stringify(e).length, 0) / 4;
    tokens += pack.files.reduce((s, f) => s + f.filePath.length, 0) / 4;
    tokens += pack.relationships.reduce((s, r) => s + JSON.stringify(r).length, 0) / 4;
    tokens += pack.recentChanges.reduce((s, c) => s + c.message.length, 0) / 4;
    return Math.round(tokens) + 20;
  }

  private trim(pack: ContextPack, budget: number): ContextPack {
    const trimmed = { ...pack };

    while (this.estimateTokens(trimmed) > budget && trimmed.dependents.length > 0) {
      trimmed.dependents.pop();
    }
    while (this.estimateTokens(trimmed) > budget && trimmed.dependencies.length > 0) {
      trimmed.dependencies.pop();
    }
    while (this.estimateTokens(trimmed) > budget && trimmed.similarEntities.length > 0) {
      trimmed.similarEntities.pop();
    }
    while (this.estimateTokens(trimmed) > budget && trimmed.recentChanges.length > 0) {
      trimmed.recentChanges.pop();
    }

    trimmed.metadata.entityCount =
      1 + trimmed.dependencies.length + trimmed.dependents.length + trimmed.similarEntities.length;
    trimmed.tokenCount = this.estimateTokens(trimmed);
    return trimmed;
  }

  private trimTask(pack: TaskContextPack, budget: number): TaskContextPack {
    const trimmed = { ...pack, recentChanges: [...pack.recentChanges], relationships: [...pack.relationships] };

    while (this.estimateTaskTokens(trimmed) > budget && trimmed.recentChanges.length > 0) {
      trimmed.recentChanges.pop();
    }
    while (this.estimateTaskTokens(trimmed) > budget && trimmed.relationships.length > 0) {
      trimmed.relationships.pop();
    }
    while (this.estimateTaskTokens(trimmed) > budget && trimmed.focalEntities.length > 1) {
      trimmed.focalEntities.pop();
    }

    trimmed.tokenCount = this.estimateTaskTokens(trimmed);
    return trimmed;
  }
}

const BOUNDARY_TYPES = [
  RelationshipType.IMPORTS,
  RelationshipType.CALLS,
  RelationshipType.REFERENCES,
  RelationshipType.EXTENDS,
  RelationshipType.IMPLEMENTS,
];

function dedupeCommits(commitsByFile: Map<string, Commit[]>): Commit[] {
  const seen = new Set<string>();
  const out: Commit[] = [];
  for (const list of commitsByFile.values()) {
    for (const c of list) {
      const key = `${c.repoPath ?? ''}:${c.hash}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
  }
  return out;
}
