import { Entity, ContextPack } from '@repo-memory/shared';
import { EntityRepository, CommitRepository } from '@repo-memory/storage';
import { GraphClient } from '@repo-memory/graph';

export class ContextPackBuilder {
  constructor(
    private entityRepo: EntityRepository,
    private commitRepo: CommitRepository,
    private graphClient: GraphClient
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
        c.filesChanged.some(f => f === entity.filePath)
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
}
