import { Entity, Relationship, EntityType, FileChurnRow } from '@repo-memory/shared';
import { streamDeadCode, streamBoundaries, forEachPage, resolveBatchSize } from './streaming.js';
import type { PagedSource } from './streaming.js';

export interface FileChurn {
  filePath: string;
  commits: number;
  additions: number;
  deletions: number;
  churnScore: number;
  lastChanged: Date;
  daysSinceLastChange: number;
}

export interface RiskBreakdown {
  churn: number;
  fanout: number;
  boundary: number;
  deadCode: number;
  staleness: number;
}

export interface FileRisk {
  filePath: string;
  score: number;
  breakdown: RiskBreakdown;
  reasons: string[];
}

export interface EntityChangeInfo {
  stableId: string;
  name: string;
  filePath: string;
  repoPath?: string;
  commitCount: number;
  firstSeenCommit?: string;
  lastSeenCommit?: string;
  stalenessDays: number | null;
  owningFileChurn: FileChurn | null;
}

export type DriftSignalType = 'test-gap' | 'recent-boundary-violation' | 'unstable-public-surface';

export interface DriftSignal {
  type: DriftSignalType;
  severity: 'low' | 'medium' | 'high';
  description: string;
  evidence: string[];
}

export interface DriftReport {
  signals: DriftSignal[];
}

// Minimal data access contract so the analysis package stays free of
// pg/storage/graph dependencies. The API/orchestrator layers implement it.
// Paged methods are preferred by the streaming analysis paths; when absent the
// full-array `entities`/`relationships` methods are sliced into pages instead
// (identical results, larger peak memory).
export interface ChangeDataProvider {
  fileChurnRows(repoPath: string, days?: number): Promise<FileChurnRow[]>;
  entities(repoPath: string): Promise<Entity[]>;
  relationships(repoPath: string): Promise<Relationship[]>;
  lastCommitDate(repoPath: string): Promise<Date | null>;
  entityPage?(repoPath: string, offset: number, limit: number): Promise<Entity[]>;
  relationshipPage?(repoPath: string, offset: number, limit: number): Promise<Relationship[]>;
  entityByStableId?(repoPath: string, stableId: string): Promise<Entity | null>;
}

const DELETE_WEIGHT = 2;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, (to.getTime() - from.getTime()) / 86400000);
}

function lazyPageSource<T>(load: () => Promise<T[]>): PagedSource<T> {
  let cache: T[] | null = null;
  return {
    page: async (offset: number, limit: number) => {
      cache ??= await load();
      return cache.slice(offset, offset + limit);
    },
  };
}

export class ChangeAnalyzer {
  constructor(private provider: ChangeDataProvider) {}

  private entitySource(repoPath: string): PagedSource<Entity> {
    if (this.provider.entityPage) {
      return { page: (offset, limit) => this.provider.entityPage!(repoPath, offset, limit) };
    }
    return lazyPageSource(() => this.provider.entities(repoPath));
  }

  private relationshipSource(repoPath: string): PagedSource<Relationship> {
    if (this.provider.relationshipPage) {
      return { page: (offset, limit) => this.provider.relationshipPage!(repoPath, offset, limit) };
    }
    return lazyPageSource(() => this.provider.relationships(repoPath));
  }

  async computeFileChurn(repoPath: string, limit: number = 50, days?: number): Promise<FileChurn[]> {
    const rows = await this.provider.fileChurnRows(repoPath, days);
    const now = new Date();
    return rows
      .map(row => {
        const lastChanged = new Date(row.lastChanged);
        return {
          filePath: normalizePath(row.filePath),
          commits: row.commits,
          additions: row.additions,
          deletions: row.deletions,
          churnScore: row.additions + DELETE_WEIGHT * row.deletions,
          lastChanged,
          daysSinceLastChange: Math.round(daysBetween(lastChanged, now)),
        };
      })
      .sort((a, b) => b.churnScore - a.churnScore)
      .slice(0, limit);
  }

  async computeFileRisk(repoPath: string): Promise<FileRisk[]> {
    const batchSize = resolveBatchSize();
    const entities = this.entitySource(repoPath);
    const relationships = this.relationshipSource(repoPath);

    // Dead code + boundary reports are computed over the same paged streams the
    // rest of the analysis uses, so only one window of each store is resident at
    // a time regardless of repo size.
    const churnList = await this.computeFileChurn(repoPath, 1000);
    const [dead, boundary] = await Promise.all([
      streamDeadCode(entities, relationships, { batchSize }),
      streamBoundaries(entities, relationships, undefined, { batchSize }),
    ]);
    const deadIds = new Set(dead.deadCode.map(i => i.entity.stableId));

    // Entities grouped by file (excluding File nodes themselves), stored as
    // bare stable IDs so we never hold the full entity objects in memory.
    const entitiesByFile = new Map<string, string[]>();
    const targetFileOf = new Map<string, string>();
    await forEachPage(entities, batchSize, (rows) => {
      for (const entity of rows) {
        if (entity.type === EntityType.FILE) continue;
        const key = normalizePath(entity.filePath);
        const list = entitiesByFile.get(key);
        if (list) list.push(entity.stableId);
        else entitiesByFile.set(key, [entity.stableId]);
        targetFileOf.set(entity.stableId, key);
      }
    });

    // Inbound fan-out per file: count relationships whose target is in that file.
    const fanoutByFile = new Map<string, number>();
    await forEachPage(relationships, batchSize, (rows) => {
      for (const rel of rows) {
        const targetFile = targetFileOf.get(rel.targetId);
        if (targetFile) fanoutByFile.set(targetFile, (fanoutByFile.get(targetFile) || 0) + 1);
      }
    });

    const maxChurn = Math.max(1, ...churnList.map(c => c.churnScore));

    const risks: FileRisk[] = [];
    for (const churn of churnList) {
      const fileStableIds = entitiesByFile.get(churn.filePath) || [];
      const churnRisk = Math.round((churn.churnScore / maxChurn) * 100);
      const fanout = fanoutByFile.get(churn.filePath) || 0;
      const fanoutRisk = Math.min(100, fanout * 10);
      const violations = boundary.crossDomainEdges.filter(
        v => normalizePath(v.source.filePath) === churn.filePath || normalizePath(v.target.filePath) === churn.filePath
      );
      const boundaryRisk = Math.min(100, violations.length * 25);
      const deadCount = fileStableIds.filter(id => deadIds.has(id)).length;
      const deadCodeRisk = Math.min(100, deadCount * 25);
      const stalenessRisk = Math.min(100, (churn.daysSinceLastChange / 365) * 100);

      const score = Math.round(
        churnRisk * 0.3 + fanoutRisk * 0.25 + boundaryRisk * 0.2 + deadCodeRisk * 0.15 + stalenessRisk * 0.1
      );

      const reasons: string[] = [];
      if (churnRisk >= 50) reasons.push(`high churn (${churn.commits} commits, +${churn.additions}/-${churn.deletions})`);
      if (fanoutRisk >= 50) reasons.push(`${fanout} inbound dependents`);
      if (violations.length) reasons.push(`${violations.length} cross-domain edge(s)`);
      if (deadCount) reasons.push(`${deadCount} dead-code symbol(s)`);
      if (stalenessRisk >= 50) reasons.push(`stale for ${churn.daysSinceLastChange} days`);

      risks.push({
        filePath: churn.filePath,
        score,
        breakdown: { churn: churnRisk, fanout: fanoutRisk, boundary: boundaryRisk, deadCode: deadCodeRisk, staleness: stalenessRisk },
        reasons,
      });
    }

    return risks.sort((a, b) => b.score - a.score);
  }

  async computeEntityChange(repoPath: string, stableId: string): Promise<EntityChangeInfo | null> {
    const entity = this.provider.entityByStableId
      ? await this.provider.entityByStableId(repoPath, stableId)
      : (await this.provider.entities(repoPath)).find(e => e.stableId === stableId);
    if (!entity) return null;

    const churn = await this.computeFileChurn(repoPath, 100000);
    const owning = churn.find(c => c.filePath === normalizePath(entity.filePath)) || null;

    return {
      stableId: entity.stableId,
      name: entity.name,
      filePath: entity.filePath,
      repoPath: entity.repoPath,
      commitCount: owning?.commits ?? 0,
      firstSeenCommit: entity.firstSeenCommit,
      lastSeenCommit: entity.lastSeenCommit,
      stalenessDays: owning ? owning.daysSinceLastChange : null,
      owningFileChurn: owning,
    };
  }

  async detectDrift(repoPath: string): Promise<DriftReport> {
    const WINDOW_DAYS = 90;
    const batchSize = resolveBatchSize();
    const entities = this.entitySource(repoPath);
    const relationships = this.relationshipSource(repoPath);

    const [recent, all] = await Promise.all([
      this.computeFileChurn(repoPath, 200, WINDOW_DAYS),
      this.computeFileChurn(repoPath, 2000),
    ]);

    const recentByFile = new Map(recent.map(c => [c.filePath, c]));

    // Stream entities to collect the file-path universe and per-file exported
    // symbol counts; neither needs the full entity objects retained.
    const fileNames = new Set<string>();
    const exportedByFile = new Map<string, number>();
    await forEachPage(entities, batchSize, (rows) => {
      for (const entity of rows) {
        const key = normalizePath(entity.filePath);
        fileNames.add(key);
        if (entity.isExported) {
          exportedByFile.set(key, (exportedByFile.get(key) || 0) + 1);
        }
      }
    });

    const boundary = await streamBoundaries(entities, relationships, undefined, { batchSize });

    const signals: DriftSignal[] = [];

    const isTestPath = (p: string) => /(test|tests|__tests__|spec)/i.test(p) && /\.(test|spec)\.|test_|_test/.test(p);

    // Test-gap: high-churn source files whose matching test file did not change in the window
    const highChurn = recent.filter(c => c.churnScore >= 50);
    for (const churn of highChurn) {
      if (isTestPath(churn.filePath)) continue;
      const dir = churn.filePath.split('/').slice(0, -1).join('/');
      const base = churn.filePath.split('/').pop()!.replace(/\.[^.]+$/, '');
      const testMatches = [...fileNames].filter(p =>
        isTestPath(p) && (dir === '' || p.startsWith(`${dir}/`)) && p.includes(base)
      );
      const changed = testMatches.some(p => recentByFile.has(p));
      if (!changed && testMatches.length > 0) {
        signals.push({
          type: 'test-gap',
          severity: 'medium',
          description:
            `${churn.filePath} changed ${churn.commits} time(s) in the last ${WINDOW_DAYS} days but its test file(s) did not change`,
          evidence: [
            `${churn.additions} additions, ${churn.deletions} deletions`,
            `test files unchanged: ${testMatches.join(', ')}`,
          ],
        });
      }
    }

    // Boundary violations involving files that changed recently
    const violatingRecent = boundary.violations.filter(
      v => recentByFile.has(normalizePath(v.source.filePath)) || recentByFile.has(normalizePath(v.target.filePath))
    );
    if (violatingRecent.length) {
      signals.push({
        type: 'recent-boundary-violation',
        severity: 'high',
        description: `${violatingRecent.length} boundary violation(s) involve file(s) changed in the last ${WINDOW_DAYS} days`,
        evidence: violatingRecent
          .slice(0, 5)
          .map(v => `${v.source.filePath} [${v.relationshipType}] -> ${v.target.filePath} (${v.source.domain} -> ${v.target.domain})`),
      });
    }

    // Unstable public surfaces: exported symbols in files touched by many commits
    for (const churn of all) {
      const exported = exportedByFile.get(churn.filePath) || 0;
      if (exported > 0 && churn.commits >= 5) {
        signals.push({
          type: 'unstable-public-surface',
          severity: 'medium',
          description: `${churn.filePath} exports ${exported} symbol(s) and was touched by ${churn.commits} commits`,
          evidence: [
            `${churn.additions} additions, ${churn.deletions} deletions`,
            `last changed ${churn.daysSinceLastChange} day(s) ago`,
          ],
        });
      }
    }

    // Deduplicate
    const seen = new Set<string>();
    const deduped = signals.filter(s => {
      const key = `${s.type}|${s.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return { signals: deduped };
  }
}
