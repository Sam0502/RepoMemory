import { Entity, Relationship, RelationshipType, EntityType } from '@repo-memory/shared';
import { resolveImportPath } from './ids.js';

export interface SymbolDefinition {
  name: string;
  filePath: string;
  stableId: string;
  type: EntityType;
  isExported: boolean;
}

export interface ResolvedSymbol {
  definition: SymbolDefinition;
  hint: string;
  confidence: number;
}

// Repo-wide index of entity definitions and per-file import maps, used to resolve
// bare symbol references (CALLS/REFERENCES/EXTENDS/IMPLEMENTS/import symbols) to
// real entity stable IDs.
export class SymbolIndex {
  private byName = new Map<string, SymbolDefinition[]>();
  private byFile = new Map<string, SymbolDefinition[]>();
  private stableIdToFile = new Map<string, string>();
  private seenStableIds = new Set<string>();
  // filePath -> localSymbolName -> resolved target file path
  private imports = new Map<string, Map<string, string>>();
  readonly knownFiles = new Set<string>();

  constructor(private repoPath: string = '') {}

  addEntity(entity: Entity): void {
    if (this.seenStableIds.has(entity.stableId)) return;
    this.seenStableIds.add(entity.stableId);

    const def: SymbolDefinition = {
      name: entity.name,
      filePath: entity.filePath,
      stableId: entity.stableId,
      type: entity.type,
      isExported: entity.isExported,
    };
    this.push(this.byName, entity.name, def);
    this.push(this.byFile, entity.filePath, def);
    this.stableIdToFile.set(entity.stableId, entity.filePath);
    this.knownFiles.add(entity.filePath);
  }

  addEntities(entities: Entity[]): void {
    for (const entity of entities) this.addEntity(entity);
  }

  addFile(filePath: string): void {
    this.knownFiles.add(filePath);
  }

  registerImportSymbol(sourceFilePath: string, localName: string, targetFilePath: string): void {
    let map = this.imports.get(sourceFilePath);
    if (!map) {
      map = new Map();
      this.imports.set(sourceFilePath, map);
    }
    map.set(localName, targetFilePath);
  }

  // Build the per-file import map from IMPORT relationships, resolving import
  // paths to known files. Must be called after all known file paths are added.
  registerRelationships(relationships: Relationship[]): void {
    for (const rel of relationships) {
      if (rel.type !== RelationshipType.IMPORTS) continue;
      const metadata = (rel.metadata || {}) as Record<string, unknown>;
      const importPath = metadata.importPath;
      if (typeof importPath !== 'string') continue;
      const targetFilePath = resolveImportPath(rel.filePath, importPath, this.knownFiles);
      if (targetFilePath) {
        this.registerImportSymbol(rel.filePath, rel.targetId, targetFilePath);
      }
    }
  }

  definitionsByName(name: string): SymbolDefinition[] {
    return this.byName.get(name) || [];
  }

  definitionsInFile(filePath: string): SymbolDefinition[] {
    return this.byFile.get(filePath) || [];
  }

  fileOf(stableId: string): string | null {
    return this.stableIdToFile.get(stableId) || null;
  }

  hasEntity(stableId: string): boolean {
    return this.seenStableIds.has(stableId);
  }

  // Scope-aware lookup: same-file -> imported -> globally-unique -> ambiguous exported.
  lookup(name: string, sourceFilePath: string): ResolvedSymbol | null {
    const local = (this.byFile.get(sourceFilePath) || []).filter(def => def.name === name);
    if (local.length > 0) {
      return { definition: local[0], hint: 'same-file', confidence: 1.0 };
    }

    const importMap = this.imports.get(sourceFilePath);
    if (importMap) {
      const targetFile = importMap.get(name);
      if (targetFile) {
        const imported = (this.byFile.get(targetFile) || []).filter(def => def.name === name);
        if (imported.length > 0) {
          return { definition: imported[0], hint: 'import', confidence: 1.0 };
        }
      }
    }

    const global = this.byName.get(name) || [];
    if (global.length === 1) {
      return { definition: global[0], hint: 'global-unique', confidence: 0.8 };
    }

    if (global.length > 1) {
      const exported = global.filter(def => def.isExported);
      const picked = exported.length === 1 ? exported[0] : global[0];
      return { definition: picked, hint: 'ambiguous', confidence: 0.6 };
    }

    return null;
  }

  private push(map: Map<string, SymbolDefinition[]>, key: string, value: SymbolDefinition): void {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  }
}
