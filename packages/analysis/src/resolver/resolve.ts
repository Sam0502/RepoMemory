import { Relationship, RelationshipType } from '@repo-memory/shared';
import { SymbolIndex } from './symbol-index.js';
import { generateFileStableId } from './ids.js';

const SYMBOL_TARGET_TYPES = new Set<RelationshipType>([
  RelationshipType.CALLS,
  RelationshipType.REFERENCES,
  RelationshipType.EXTENDS,
  RelationshipType.IMPLEMENTS,
  RelationshipType.HANDLES,
]);

// Rewrites bare-name relationship targets to real entity stable IDs using a
// repo-wide SymbolIndex, recording provenance in relationship.metadata.
export class RelationshipResolver {
  constructor(private index: SymbolIndex, private repoPath: string = '') {}

  resolveRelationships(relationships: Relationship[]): Relationship[] {
    return relationships.map(rel => this.resolveRelationship(rel));
  }

  private resolveRelationship(rel: Relationship): Relationship {
    if (rel.type === RelationshipType.IMPORTS) {
      return this.resolveImport(rel);
    }
    if (SYMBOL_TARGET_TYPES.has(rel.type)) {
      return this.resolveSymbolTarget(rel);
    }
    return rel;
  }

  private resolveImport(rel: Relationship): Relationship {
    const metadata = (rel.metadata || {}) as Record<string, unknown>;
    const importPath = metadata.importPath;
    const sourceFilePath = rel.filePath;

    // Symbol import (metadata.importPath present): source = current file, target = local symbol name
    if (typeof importPath === 'string') {
      const fileStableId = generateFileStableId(this.repoPath, sourceFilePath);
      const resolved = this.index.lookup(rel.targetId, sourceFilePath);
      if (resolved) {
        return {
          ...rel,
          sourceId: fileStableId,
          targetId: resolved.definition.stableId,
          confidence: resolved.confidence,
          metadata: { ...metadata, resolvedBy: 'symbol-index', resolutionHint: resolved.hint },
        };
      }
      return {
        ...rel,
        sourceId: fileStableId,
        confidence: 0.3,
        metadata: { ...metadata, resolvedBy: 'symbol-index', resolutionHint: 'unresolved' },
      };
    }

    // Module-level import: leave file-path pairs untouched for the architecture view
    return rel;
  }

  private resolveSymbolTarget(rel: Relationship): Relationship {
    const sourceFilePath = this.index.fileOf(rel.sourceId);
    const name = rel.targetId;
    const metadata = (rel.metadata || {}) as Record<string, unknown>;

    // Target is already a real entity stable ID (e.g. an inline handler entity) —
    // nothing to resolve.
    if (this.index.hasEntity(rel.targetId)) {
      return {
        ...rel,
        confidence: rel.confidence,
        metadata: { ...metadata, resolvedBy: 'symbol-index', resolutionHint: 'already-resolved' },
      };
    }

    if (!sourceFilePath) {
      return this.markUnresolved(rel, metadata, 'no-source-file', name);
    }

    const candidates: Array<{ name: string; hint: string }> = [{ name, hint: 'full' }];
    if (name.startsWith('this.')) {
      candidates.unshift({ name: name.slice(5), hint: 'this-member' });
    }
    if (name.includes('.')) {
      const lastSegment = name.split('.').pop() || name;
      candidates.push({ name: lastSegment, hint: 'member-last-segment' });
    }

    for (const candidate of candidates) {
      const resolved = this.index.lookup(candidate.name, sourceFilePath);
      if (resolved) {
        return {
          ...rel,
          targetId: resolved.definition.stableId,
          confidence: resolved.confidence,
          metadata: { ...metadata, resolvedBy: 'symbol-index', resolutionHint: `${candidate.hint}:${resolved.hint}` },
        };
      }
    }

    return this.markUnresolved(rel, metadata, 'unresolved', name);
  }

  private markUnresolved(rel: Relationship, metadata: Record<string, unknown>, hint: string, originalTarget: string): Relationship {
    return {
      ...rel,
      confidence: Math.min(rel.confidence ?? 1.0, 0.3),
      metadata: {
        ...metadata,
        resolvedBy: 'symbol-index',
        resolutionHint: hint,
        unresolvedTarget: originalTarget,
      },
    };
  }
}
