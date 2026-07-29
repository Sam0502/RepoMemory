import { Language, ParseResult, Entity, Relationship, EntityType, RelationshipType } from '@repo-memory/shared';
import { createHash } from 'crypto';

export interface ParserConfig {
  language: Language;
  fileExtensions: string[];
}

export const PARSER_CONFIGS: Record<string, ParserConfig> = {
  typescript: {
    language: Language.TYPESCRIPT,
    fileExtensions: ['.ts', '.tsx'],
  },
  javascript: {
    language: Language.JAVASCRIPT,
    fileExtensions: ['.js', '.jsx', '.mjs', '.cjs'],
  },
};

export class TreeSitterParser {
  private language: Language;

  constructor(language: Language) {
    this.language = language;
  }

  async initialize(): Promise<void> {
    console.log(`Initializing Tree-sitter parser for ${this.language}...`);
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    const entities: Entity[] = [];
    const relationships: Relationship[] = [];
    const errors: ParseResult['errors'] = [];

    try {
      const lines = content.split('\n');
      
      // Extract imports and create relationships
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const importMatch = line.match(/import\s+(?:\{[^}]+\}|[\w*]+)\s+from\s+['"](.+)['"]/);
        if (importMatch) {
          const importPath = importMatch[1];
          relationships.push({
            id: createHash('md5').update(`import:${filePath}:${importPath}`).digest('hex'),
            sourceId: filePath,
            targetId: importPath,
            type: RelationshipType.IMPORTS,
            filePath,
            line: i + 1,
            confidence: 1.0,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }

      // Extract named imports for specific symbols
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const namedImportMatch = line.match(/import\s+\{([^}]+)\}\s+from\s+['"](.+)['"]/);
        if (namedImportMatch) {
          const symbols = namedImportMatch[1].split(',').map(s => s.trim().split(' as ')[0].trim());
          const importPath = namedImportMatch[2];
          
          for (const symbol of symbols) {
            if (symbol && symbol.length > 0) {
              relationships.push({
                id: createHash('md5').update(`import-symbol:${filePath}:${symbol}:${importPath}`).digest('hex'),
                sourceId: filePath,
                targetId: symbol,
                type: RelationshipType.IMPORTS,
                filePath,
                line: i + 1,
                confidence: 0.9,
                createdAt: new Date(),
                updatedAt: new Date(),
              });
            }
          }
        }
      }

      // Extract exports with proper entity creation
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const exportMatch = line.match(/export\s+(?:default\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/);
        if (exportMatch) {
          const name = exportMatch[1];
          const stableId = this.generateStableId(filePath, name);
          const entityType = this.determineEntityType(line, name);
          
          const entity = this.createEntity(name, filePath, entityType, i + 1, i + 1, true);
          if (entity) {
            entities.push(entity);
            relationships.push({
              id: createHash('md5').update(`export:${filePath}:${name}`).digest('hex'),
              sourceId: filePath,
              targetId: stableId,
              type: RelationshipType.EXPORTS,
              filePath,
              line: i + 1,
              confidence: 1.0,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        }
      }

      // Extract function declarations
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const functionMatch = line.match(/(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
        if (functionMatch) {
          const name = functionMatch[1];
          const isExported = line.includes('export');
          const entity = this.createEntity(name, filePath, EntityType.FUNCTION, i + 1, i + 1, isExported);
          if (entity) {
            entities.push(entity);
          }
        }
      }

      // Extract class declarations
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const classMatch = line.match(/(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
        if (classMatch) {
          const name = classMatch[1];
          const isExported = line.includes('export');
          const entity = this.createEntity(name, filePath, EntityType.CLASS, i + 1, i + 1, isExported);
          if (entity) {
            entities.push(entity);
          }
        }
      }

      // Extract interface declarations
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const interfaceMatch = line.match(/(?:export\s+)?interface\s+(\w+)/);
        if (interfaceMatch) {
          const name = interfaceMatch[1];
          const isExported = line.includes('export');
          const entity = this.createEntity(name, filePath, EntityType.INTERFACE, i + 1, i + 1, isExported);
          if (entity) {
            entities.push(entity);
          }
        }
      }

      // Extract type declarations
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const typeMatch = line.match(/(?:export\s+)?type\s+(\w+)/);
        if (typeMatch) {
          const name = typeMatch[1];
          const isExported = line.includes('export');
          const entity = this.createEntity(name, filePath, EntityType.TYPE_ALIAS, i + 1, i + 1, isExported);
          if (entity) {
            entities.push(entity);
          }
        }
      }

      // Extract enum declarations
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const enumMatch = line.match(/(?:export\s+)?enum\s+(\w+)/);
        if (enumMatch) {
          const name = enumMatch[1];
          const isExported = line.includes('export');
          const entity = this.createEntity(name, filePath, EntityType.ENUM, i + 1, i + 1, isExported);
          if (entity) {
            entities.push(entity);
          }
        }
      }

      // Extract const declarations with function values
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const constFnMatch = line.match(/(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
        if (constFnMatch) {
          const name = constFnMatch[1];
          const isExported = line.includes('export');
          const entity = this.createEntity(name, filePath, EntityType.FUNCTION, i + 1, i + 1, isExported);
          if (entity) {
            entities.push(entity);
          }
        }
      }

      // Extract extends/implements relationships
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const extendsMatch = line.match(/class\s+(\w+)\s+extends\s+(\w+)/);
        if (extendsMatch) {
          const childName = extendsMatch[1];
          const parentName = extendsMatch[2];
          relationships.push({
            id: createHash('md5').update(`extends:${filePath}:${childName}:${parentName}`).digest('hex'),
            sourceId: this.generateStableId(filePath, childName),
            targetId: parentName,
            type: RelationshipType.EXTENDS,
            filePath,
            line: i + 1,
            confidence: 0.9,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }

        const implementsMatch = line.match(/class\s+(\w+)\s+implements\s+([\w,\s]+)/);
        if (implementsMatch) {
          const className = implementsMatch[1];
          const interfaces = implementsMatch[2].split(',').map(s => s.trim());
          
          for (const iface of interfaces) {
            relationships.push({
              id: createHash('md5').update(`implements:${filePath}:${className}:${iface}`).digest('hex'),
              sourceId: this.generateStableId(filePath, className),
              targetId: iface,
              type: RelationshipType.IMPLEMENTS,
              filePath,
              line: i + 1,
              confidence: 0.9,
              createdAt: new Date(),
              updatedAt: new Date(),
            });
          }
        }
      }

    } catch (error) {
      errors.push({
        filePath,
        line: 0,
        column: 0,
        message: error instanceof Error ? error.message : 'Unknown parse error',
      });
    }

    return {
      filePath,
      language: this.language,
      entities,
      relationships,
      errors,
    };
  }

  private determineEntityType(line: string, name: string): EntityType {
    if (line.match(/class\s/)) return EntityType.CLASS;
    if (line.match(/interface\s/)) return EntityType.INTERFACE;
    if (line.match(/type\s/)) return EntityType.TYPE_ALIAS;
    if (line.match(/enum\s/)) return EntityType.ENUM;
    if (line.match(/function\s/)) return EntityType.FUNCTION;
    if (line.match(/const|let|var/)) return EntityType.VARIABLE;
    return EntityType.FUNCTION;
  }

  private createEntity(
    name: string, 
    filePath: string, 
    type: EntityType, 
    startLine: number, 
    endLine: number, 
    isExported: boolean
  ): Entity | null {
    if (!name || name.length === 0) {
      return null;
    }

    const stableId = this.generateStableId(filePath, name);

    return {
      id: stableId,
      stableId,
      name,
      type,
      language: this.language,
      filePath,
      startLine,
      endLine,
      startColumn: 0,
      endColumn: 0,
      isExported,
      isTest: filePath.includes('.test.') || filePath.includes('.spec.'),
      confidence: 0.8,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private generateStableId(filePath: string, name: string): string {
    const input = `${filePath}:${name}`;
    return createHash('md5').update(input).digest('hex');
  }
}

export function getLanguageFromFilePath(filePath: string): Language {
  const ext = filePath.split('.').pop()?.toLowerCase();
  
  switch (ext) {
    case 'ts':
    case 'tsx':
      return Language.TYPESCRIPT;
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return Language.JAVASCRIPT;
    default:
      return Language.UNKNOWN;
  }
}

export function shouldParseFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext || '');
}
