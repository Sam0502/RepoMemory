import { Entity, Relationship, EntityType, RelationshipType, Language } from '@repo-memory/shared';
import { createHash } from 'crypto';
import { ExtractorContext, LanguageExtractor } from './interface.js';

export abstract class BaseExtractor implements LanguageExtractor {
  abstract language: Language;

  abstract extractNodes(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void;

  protected createEntity(
    name: string,
    ctx: ExtractorContext,
    type: EntityType,
    node: any,
    isExported: boolean
  ): Entity | null {
    if (!name || name.length === 0) return null;

    const stableId = this.generateStableId(ctx.filePath, name, ctx.repoPath);

    return {
      id: stableId,
      stableId,
      name,
      type,
      language: ctx.language,
      filePath: ctx.filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      isExported,
      isTest: this.isTestFile(ctx.filePath),
      confidence: 0.9,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  protected createExportRel(filePath: string, stableId: string, node: any): Relationship {
    return {
      id: createHash('md5').update(`export:${filePath}:${stableId}`).digest('hex'),
      sourceId: filePath,
      targetId: stableId,
      type: RelationshipType.EXPORTS,
      filePath,
      line: node.startPosition.row + 1,
      confidence: 1.0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  protected createHeritageRel(
    childId: string,
    parentName: string,
    type: RelationshipType,
    filePath: string,
    node: any
  ): Relationship {
    const truncatedParent = this.truncateId(parentName);
    return {
      id: createHash('md5').update(`${type.toLowerCase()}:${filePath}:${childId}:${truncatedParent}`).digest('hex'),
      sourceId: childId,
      targetId: truncatedParent,
      type,
      filePath,
      line: node.startPosition.row + 1,
      confidence: 0.9,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  protected createContainsRel(
    parentId: string,
    childId: string,
    filePath: string,
    node: any
  ): Relationship {
    return {
      id: createHash('md5').update(`contains:${filePath}:${parentId}:${childId}`).digest('hex'),
      sourceId: parentId,
      targetId: childId,
      type: RelationshipType.CONTAINS,
      filePath,
      line: node.startPosition.row + 1,
      confidence: 1.0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  protected createCallsRel(
    callerId: string,
    calleeName: string,
    filePath: string,
    node: any
  ): Relationship {
    const truncatedCallee = this.truncateId(calleeName);
    return {
      id: createHash('md5').update(`calls:${filePath}:${callerId}:${truncatedCallee}`).digest('hex'),
      sourceId: callerId,
      targetId: truncatedCallee,
      type: RelationshipType.CALLS,
      filePath,
      line: node.startPosition.row + 1,
      confidence: 0.7,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  protected createReferencesRel(
    sourceId: string,
    targetName: string,
    filePath: string,
    node: any
  ): Relationship {
    const truncatedTarget = this.truncateId(targetName);
    return {
      id: createHash('md5').update(`references:${filePath}:${sourceId}:${truncatedTarget}`).digest('hex'),
      sourceId,
      targetId: truncatedTarget,
      type: RelationshipType.REFERENCES,
      filePath,
      line: node.startPosition.row + 1,
      confidence: 0.6,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  protected extractReferencesFromNode(
    node: any,
    sourceStableId: string,
    ctx: ExtractorContext,
    relationships: Relationship[]
  ): void {
    // Find all identifier references (excluding function calls which are handled by CALLS)
    const identifiers = this.descendantsOfType(node, 'identifier');
    
    for (const identifier of identifiers) {
      // Skip identifiers that are part of function calls (handled by extractCallsFromNode)
      if (identifier.parent?.type === 'call_expression') continue;
      
      // Skip identifiers that are function definitions
      if (identifier.parent?.type === 'function_declaration' && 
          identifier.parent.childForFieldName('name') === identifier) continue;
      
      // Skip identifiers that are variable declarations
      if (identifier.parent?.type === 'variable_declarator' && 
          identifier.parent.childForFieldName('name') === identifier) continue;
      
      const name = identifier.text;
      if (name && name.length > 1) { // Skip single-char identifiers
        relationships.push(this.createReferencesRel(sourceStableId, name, ctx.filePath, identifier));
      }
    }
  }

  protected createImportRel(
    filePath: string,
    importPath: string,
    node: any,
    confidence: number = 1.0
  ): Relationship {
    const truncatedPath = this.truncateId(importPath);
    return {
      id: createHash('md5').update(`import:${filePath}:${truncatedPath}`).digest('hex'),
      sourceId: filePath,
      targetId: truncatedPath,
      type: RelationshipType.IMPORTS,
      filePath,
      line: node.startPosition.row + 1,
      confidence,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  protected createImportSymbolRel(
    filePath: string,
    symbol: string,
    importPath: string,
    node: any
  ): Relationship {
    const truncatedSymbol = this.truncateId(symbol);
    const truncatedPath = this.truncateId(importPath);
    return {
      id: createHash('md5').update(`import-symbol:${filePath}:${truncatedSymbol}:${truncatedPath}`).digest('hex'),
      sourceId: filePath,
      targetId: truncatedSymbol,
      type: RelationshipType.IMPORTS,
      filePath,
      line: node.startPosition.row + 1,
      confidence: 0.9,
      metadata: { importPath },
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  protected generateStableId(filePath: string, name: string, repoPath: string = ''): string {
    const input = `${repoPath}:${filePath}:${name}`;
    return createHash('md5').update(input).digest('hex');
  }

  protected truncateId(id: string, maxLength: number = 500): string {
    if (id.length <= maxLength) return id;
    // Truncate and add hash suffix to maintain uniqueness
    const hash = createHash('md5').update(id).digest('hex').slice(0, 8);
    return `${id.slice(0, maxLength - 9)}_${hash}`;
  }

  protected isTestFile(filePath: string): boolean {
    return filePath.includes('.test.') || 
           filePath.includes('.spec.') || 
           filePath.includes('/__tests__/') ||
           filePath.includes('/test/') ||
           filePath.includes('/tests/');
  }

  protected isTestFunction(name: string): boolean {
    // Detect test functions by naming patterns
    const lowerName = name.toLowerCase();
    return lowerName.startsWith('test') || 
           lowerName.startsWith('it') ||
           lowerName.startsWith('should') ||
           lowerName.startsWith('describe') ||
           lowerName.startsWith('expect');
  }

  protected isTestSuite(name: string): boolean {
    const lowerName = name.toLowerCase();
    return lowerName === 'describe' || 
           lowerName === 'context' ||
           lowerName === 'suite';
  }

  protected isTestFileByContent(content: string): boolean {
    // Detect test files by content patterns
    const testPatterns = [
      /describe\s*\(/,
      /it\s*\(/,
      /test\s*\(/,
      /expect\s*\(/,
      /assert\./,
      /pytest\.mark/,
      /unittest\.TestCase/,
    ];
    return testPatterns.some(pattern => pattern.test(content));
  }

  protected isConfigFile(filePath: string): boolean {
    const configPatterns = [
      /package\.json$/,
      /tsconfig\.json$/,
      /\.eslintrc\./,
      /\.prettierrc\./,
      /webpack\.config\./,
      /vite\.config\./,
      /rollup\.config\./,
      /babel\.config\./,
      /jest\.config\./,
      /vitest\.config\./,
      /\.env\./,
      /docker-compose\./,
      /Dockerfile$/,
      /pyproject\.toml$/,
      /setup\.cfg$/,
      /setup\.py$/,
      /requirements.*\.txt$/,
      /Cargo\.toml$/,
      /go\.mod$/,
    ];
    return configPatterns.some(pattern => pattern.test(filePath));
  }

  protected getConfigName(filePath: string): string {
    const fileName = filePath.split('/').pop() || filePath.split('\\').pop() || filePath;
    return fileName.replace(/\.[^.]+$/, '');
  }

  protected hasExportDecorator(node: any): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement' || current.type === 'export_specifier') {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  protected findChildByType(node: any, type: string): any {
    return node.children?.find((c: any) => c.type === type);
  }

  protected findChildrenByType(node: any, type: string): any[] {
    return node.children?.filter((c: any) => c.type === type) || [];
  }

  protected descendantsOfType(node: any, type: string): any[] {
    const results: any[] = [];
    const walk = (n: any) => {
      if (n.type === type) results.push(n);
      for (const child of n.children || []) {
        walk(child);
      }
    };
    walk(node);
    return results;
  }
}
