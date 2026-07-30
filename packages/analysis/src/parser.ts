import { Language, ParseResult, Entity, Relationship, EntityType, RelationshipType } from '@repo-memory/shared';
import { createHash } from 'crypto';
import { initTreeSitter, createParser, getGrammarBytes } from './tree-sitter-init.js';

export interface ParserConfig {
  language: Language;
  grammarKey: string;
  fileExtensions: string[];
}

export const PARSER_CONFIGS: Record<string, ParserConfig> = {
  typescript: {
    language: Language.TYPESCRIPT,
    grammarKey: 'typescript',
    fileExtensions: ['.ts'],
  },
  tsx: {
    language: Language.TYPESCRIPT,
    grammarKey: 'tsx',
    fileExtensions: ['.tsx'],
  },
  javascript: {
    language: Language.JAVASCRIPT,
    grammarKey: 'javascript',
    fileExtensions: ['.js', '.jsx', '.mjs', '.cjs'],
  },
};

const TS_DEFINITE_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'method_definition',
  'property_definition',
  'required_parameter',
  'optional_parameter',
]);

export class TreeSitterParser {
  private language: Language;
  private grammarKey: string;
  private tsParser: any = null;

  constructor(language: Language) {
    this.language = language;
    this.grammarKey = this.resolveGrammarKey(language);
  }

  private resolveGrammarKey(language: Language): string {
    if (language === Language.JAVASCRIPT) return 'javascript';
    return 'typescript';
  }

  async initialize(): Promise<void> {
    await initTreeSitter();
    this.tsParser = createParser();

    const grammarBytes = await getGrammarBytes(this.grammarKey);

    const mod: any = await import('web-tree-sitter');
    const Language = mod.default?.Language || mod.Language;
    const wasmModule = await Language.load(grammarBytes);
    this.tsParser.setLanguage(wasmModule);
  }

  async parse(filePath: string, content: string): Promise<ParseResult> {
    const entities: Entity[] = [];
    const relationships: Relationship[] = [];
    const errors: ParseResult['errors'] = [];

    if (!this.tsParser) {
      errors.push({ filePath, line: 0, column: 0, message: 'Parser not initialized' });
      return { filePath, language: this.language, entities, relationships, errors };
    }

    try {
      const tree = this.tsParser.parse(content);
      if (!tree) {
        errors.push({ filePath, line: 0, column: 0, message: 'Failed to parse file' });
        return { filePath, language: this.language, entities, relationships, errors };
      }

      const rootNode = tree.rootNode;
      this.extractNodes(rootNode, filePath, entities, relationships, content);
    } catch (error) {
      errors.push({
        filePath,
        line: 0,
        column: 0,
        message: error instanceof Error ? error.message : 'Unknown parse error',
      });
    }

    return { filePath, language: this.language, entities, relationships, errors };
  }

  private extractNodes(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[],
    content: string
  ): void {
    const nodeType = node.type;

    switch (nodeType) {
      case 'function_declaration':
        this.extractFunction(node, filePath, entities, relationships);
        break;
      case 'class_declaration':
        this.extractClass(node, filePath, entities, relationships, content);
        break;
      case 'interface_declaration':
        this.extractInterface(node, filePath, entities, relationships);
        break;
      case 'type_alias_declaration':
        this.extractTypeAlias(node, filePath, entities, relationships);
        break;
      case 'enum_declaration':
        this.extractEnum(node, filePath, entities, relationships);
        break;
      case 'lexical_declaration':
        this.extractLexicalDeclaration(node, filePath, entities, relationships);
        break;
      case 'method_definition':
        this.extractMethod(node, filePath, entities, relationships);
        break;
      case 'import_statement':
        this.extractImport(node, filePath, relationships);
        break;
      case 'import_require_clause':
        this.extractRequire(node, filePath, relationships);
        break;
    }

    for (const child of node.children) {
      this.extractNodes(child, filePath, entities, relationships, content);
    }
  }

  private extractFunction(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, filePath, EntityType.FUNCTION, node, isExported);
    if (entity) entities.push(entity);

    if (isExported) {
      relationships.push(this.createExportRel(filePath, entity!.stableId, node));
    }
  }

  private extractClass(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[],
    content: string
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, filePath, EntityType.CLASS, node, isExported);
    if (entity) entities.push(entity);

    if (isExported) {
      relationships.push(this.createExportRel(filePath, entity!.stableId, node));
    }

    const heritage = node.childForFieldName('heritage');
    if (heritage) {
      for (const clause of heritage.children) {
        if (clause.type === 'extends_clause') {
          const parentNode = (clause.children as any[]).find((c: any) => c.type === 'type_identifier' || c.type === 'identifier');
          if (parentNode) {
            relationships.push(this.createHeritageRel(entity!.stableId, parentNode.text, RelationshipType.EXTENDS, filePath, node));
          }
        } else if (clause.type === 'implements_clause') {
          for (const ifaceNode of (clause.children as any[]).filter((c: any) => c.type === 'type_identifier')) {
            relationships.push(this.createHeritageRel(entity!.stableId, ifaceNode.text, RelationshipType.IMPLEMENTS, filePath, node));
          }
        }
      }
    }

    const body = node.childForFieldName('body');
    if (body) {
      for (const child of body.children) {
        if (child.type === 'method_definition') {
          this.extractMethod(child, filePath, entities, relationships);
        } else if (child.type === 'property_definition') {
          this.extractProperty(child, filePath, entities, relationships);
        }
      }
    }
  }

  private extractInterface(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, filePath, EntityType.INTERFACE, node, isExported);
    if (entity) entities.push(entity);

    if (isExported) {
      relationships.push(this.createExportRel(filePath, entity!.stableId, node));
    }

    const heritage = node.childForFieldName('heritage');
    if (heritage) {
      for (const clause of heritage.children) {
        if (clause.type === 'extends_clause') {
          for (const parentNode of (clause.children as any[]).filter((c: any) => c.type === 'type_identifier')) {
            relationships.push(this.createHeritageRel(entity!.stableId, parentNode.text, RelationshipType.EXTENDS, filePath, node));
          }
        }
      }
    }
  }

  private extractTypeAlias(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, filePath, EntityType.TYPE_ALIAS, node, isExported);
    if (entity) entities.push(entity);

    if (isExported) {
      relationships.push(this.createExportRel(filePath, entity!.stableId, node));
    }
  }

  private extractEnum(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, filePath, EntityType.ENUM, node, isExported);
    if (entity) entities.push(entity);

    if (isExported) {
      relationships.push(this.createExportRel(filePath, entity!.stableId, node));
    }
  }

  private extractLexicalDeclaration(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    for (const declarator of (node.children as any[]).filter((c: any) => c.type === 'variable_declarator')) {
      const nameNode = declarator.childForFieldName('name');
      if (!nameNode) continue;

      const name = nameNode.text;
      const value = declarator.childForFieldName('value');
      const isExported = this.hasExportDecorator(node);
      let entityType: EntityType = EntityType.VARIABLE;

      if (value) {
        if (value.type === 'arrow_function' || value.type === 'function') {
          entityType = EntityType.FUNCTION;
        }
      }

      const entity = this.createEntity(name, filePath, entityType, declarator, isExported);
      if (entity) entities.push(entity);

      if (isExported) {
        relationships.push(this.createExportRel(filePath, entity!.stableId, node));
      }
    }
  }

  private extractMethod(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const entity = this.createEntity(name, filePath, EntityType.METHOD, node, false);
    if (entity) entities.push(entity);
  }

  private extractProperty(
    node: any,
    filePath: string,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = node.childForFieldName('name') || node.children[0];
    if (!nameNode) return;

    const name = nameNode.text;
    const entity = this.createEntity(name, filePath, EntityType.PROPERTY, node, false);
    if (entity) entities.push(entity);
  }

  private extractImport(
    node: any,
    filePath: string,
    relationships: Relationship[]
  ): void {
    const sourceNode = node.childForFieldName('source');
    if (!sourceNode) return;

    const importPath = sourceNode.text.replace(/['"]/g, '');
    relationships.push({
      id: createHash('md5').update(`import:${filePath}:${importPath}`).digest('hex'),
      sourceId: filePath,
      targetId: importPath,
      type: RelationshipType.IMPORTS,
      filePath,
      line: node.startPosition.row + 1,
      confidence: 1.0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const importClause = node.childForFieldName('import_clause');
    if (importClause) {
      const namedImports = importClause.descendantsOfType('import_specifier');
      for (const spec of namedImports) {
        const nameNode = spec.childForFieldName('name');
        if (!nameNode) continue;
        const symbol = nameNode.text;
        relationships.push({
          id: createHash('md5').update(`import-symbol:${filePath}:${symbol}:${importPath}`).digest('hex'),
          sourceId: filePath,
          targetId: symbol,
          type: RelationshipType.IMPORTS,
          filePath,
          line: node.startPosition.row + 1,
          confidence: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }

      const namespace = importClause.descendantsOfType('namespace_import')[0];
      if (namespace) {
        const alias = namespace.childForFieldName('name');
        if (alias) {
          relationships.push({
            id: createHash('md5').update(`import-namespace:${filePath}:${alias.text}:${importPath}`).digest('hex'),
            sourceId: filePath,
            targetId: alias.text,
            type: RelationshipType.IMPORTS,
            filePath,
            line: node.startPosition.row + 1,
            confidence: 0.9,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        }
      }

      const defaultImport = importClause.childForFieldName('name');
      if (defaultImport && importClause.type !== 'import_specifier') {
        relationships.push({
          id: createHash('md5').update(`import-default:${filePath}:${defaultImport.text}:${importPath}`).digest('hex'),
          sourceId: filePath,
          targetId: defaultImport.text,
          type: RelationshipType.IMPORTS,
          filePath,
          line: node.startPosition.row + 1,
          confidence: 0.9,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }
  }

  private extractRequire(
    node: any,
    filePath: string,
    relationships: Relationship[]
  ): void {
    const args = (node.children as any[]).filter((c: any) => c.type === 'string' || c.type === 'template_string');
    for (const arg of args) {
      const importPath = arg.text.replace(/['"`]/g, '');
      relationships.push({
        id: createHash('md5').update(`require:${filePath}:${importPath}`).digest('hex'),
        sourceId: filePath,
        targetId: importPath,
        type: RelationshipType.IMPORTS,
        filePath,
        line: node.startPosition.row + 1,
        confidence: 0.9,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }

  private hasExportDecorator(node: any): boolean {
    let current = node.parent;
    while (current) {
      if (current.type === 'export_statement' || current.type === 'export_specifier') {
        return true;
      }
      current = current.parent;
    }
    return false;
  }

  private createEntity(
    name: string,
    filePath: string,
    type: EntityType,
    node: any,
    isExported: boolean
  ): Entity | null {
    if (!name || name.length === 0) return null;

    const stableId = this.generateStableId(filePath, name);

    return {
      id: stableId,
      stableId,
      name,
      type,
      language: this.language,
      filePath,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      isExported,
      isTest: filePath.includes('.test.') || filePath.includes('.spec.'),
      confidence: 0.9,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  private createExportRel(filePath: string, stableId: string, node: any): Relationship {
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

  private createHeritageRel(
    childId: string,
    parentName: string,
    type: RelationshipType,
    filePath: string,
    node: any
  ): Relationship {
    return {
      id: createHash('md5').update(`${type.toLowerCase()}:${filePath}:${childId}:${parentName}`).digest('hex'),
      sourceId: childId,
      targetId: parentName,
      type,
      filePath,
      line: node.startPosition.row + 1,
      confidence: 0.9,
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
