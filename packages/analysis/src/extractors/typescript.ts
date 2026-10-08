import { Entity, Relationship, EntityType, RelationshipType, Language } from '@repo-memory/shared';
import { ExtractorContext } from './interface.js';
import { BaseExtractor } from './base.js';

export class TypeScriptExtractor extends BaseExtractor {
  language: Language = Language.TYPESCRIPT;

  extractNodes(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nodeType = node.type;

    switch (nodeType) {
      case 'function_declaration':
        this.extractFunction(node, ctx, entities, relationships);
        break;
      case 'class_declaration':
        this.extractClass(node, ctx, entities, relationships);
        break;
      case 'interface_declaration':
        this.extractInterface(node, ctx, entities, relationships);
        break;
      case 'type_alias_declaration':
        this.extractTypeAlias(node, ctx, entities, relationships);
        break;
      case 'enum_declaration':
        this.extractEnum(node, ctx, entities, relationships);
        break;
      case 'lexical_declaration':
      case 'variable_declaration':
        this.extractLexicalDeclaration(node, ctx, entities, relationships);
        break;
      case 'method_definition':
        this.extractMethod(node, ctx, entities, relationships);
        break;
      case 'import_statement':
        this.extractImport(node, ctx, relationships);
        break;
      case 'expression_statement':
        this.extractExpressionStatement(node, ctx, entities, relationships);
        break;
    }

    for (const child of node.children) {
      // class_declaration already extracts its members via extractClass —
      // skip them here to avoid duplicate METHOD/PROPERTY entities.
      if (
        nodeType === 'class_declaration' &&
        (child.type === 'class_body' ||
          child.type === 'method_definition' ||
          child.type === 'property_definition' ||
          child.type === 'public_field_definition' ||
          child.type === 'constructor_definition')
      ) {
        continue;
      }
      this.extractNodes(child, ctx, entities, relationships);
    }
  }

  private extractFunction(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = this.findChildByType(node, 'identifier') || node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, ctx, EntityType.FUNCTION, node, isExported);
    if (entity) {
      entities.push(entity);

      if (isExported) {
        relationships.push(this.createExportRel(ctx.filePath, entity.stableId, node));
      }

      // Extract function calls within the function body
      this.extractCallsFromNode(node, entity.stableId, ctx, relationships);
      
      // Extract references within the function body
      this.extractReferencesFromNode(node, entity.stableId, ctx, relationships);
    }
  }

  private extractClass(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = this.findChildByType(node, 'type_identifier') || node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);
    const entityType = this.isModelClass(name, node) ? EntityType.MODEL : EntityType.CLASS;

    const entity = this.createEntity(name, ctx, entityType, node, isExported);
    if (entity) {
      entities.push(entity);

      if (isExported) {
        relationships.push(this.createExportRel(ctx.filePath, entity.stableId, node));
      }

      // Extract heritage (extends/implements)
      const heritage = this.findChildByType(node, 'heritage_clause') || node.childForFieldName('heritage');
      if (heritage) {
        for (const clause of heritage.children) {
          if (clause.type === 'extends_clause') {
            const parentNode = clause.children?.find((c: any) => 
              c.type === 'type_identifier' || c.type === 'identifier'
            );
            if (parentNode) {
              relationships.push(this.createHeritageRel(
                entity.stableId, parentNode.text, RelationshipType.EXTENDS, ctx.filePath, node
              ));
            }
          } else if (clause.type === 'implements_clause') {
            for (const ifaceNode of clause.children?.filter((c: any) => c.type === 'type_identifier') || []) {
              relationships.push(this.createHeritageRel(
                entity.stableId, ifaceNode.text, RelationshipType.IMPLEMENTS, ctx.filePath, node
              ));
            }
          }
        }
      }

      // Extract class members
      const body = this.findChildByType(node, 'class_body') || node.childForFieldName('body');
      if (body) {
        for (const child of body.children) {
          if (child.type === 'method_definition') {
            this.extractMethod(child, ctx, entities, relationships, entity.stableId);
          } else if (child.type === 'property_definition' || child.type ===('public_field_definition')) {
            this.extractProperty(child, ctx, entities, relationships, entity.stableId);
          } else if (child.type === 'constructor_definition') {
            this.extractConstructor(child, ctx, entities, relationships, entity.stableId);
          }
        }
      }
    }
  }

  private extractInterface(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = this.findChildByType(node, 'type_identifier') || node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, ctx, EntityType.INTERFACE, node, isExported);
    if (entity) {
      entities.push(entity);

      if (isExported) {
        relationships.push(this.createExportRel(ctx.filePath, entity.stableId, node));
      }

      // Extract extends
      const heritage = this.findChildByType(node, 'heritage_clause') || node.childForFieldName('heritage');
      if (heritage) {
        for (const clause of heritage.children) {
          if (clause.type === 'extends_clause') {
            for (const parentNode of clause.children?.filter((c: any) => c.type === 'type_identifier') || []) {
              relationships.push(this.createHeritageRel(
                entity.stableId, parentNode.text, RelationshipType.EXTENDS, ctx.filePath, node
              ));
            }
          }
        }
      }
    }
  }

  private extractTypeAlias(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = this.findChildByType(node, 'type_identifier') || node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, ctx, EntityType.TYPE_ALIAS, node, isExported);
    if (entity) {
      entities.push(entity);

      if (isExported) {
        relationships.push(this.createExportRel(ctx.filePath, entity.stableId, node));
      }
    }
  }

  private extractEnum(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = this.findChildByType(node, 'identifier') || node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.hasExportDecorator(node);

    const entity = this.createEntity(name, ctx, EntityType.ENUM, node, isExported);
    if (entity) {
      entities.push(entity);

      if (isExported) {
        relationships.push(this.createExportRel(ctx.filePath, entity.stableId, node));
      }
    }
  }

  private extractLexicalDeclaration(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    for (const declarator of node.children?.filter((c: any) => c.type === 'variable_declarator') || []) {
      const nameNode = this.findChildByType(declarator, 'identifier') || declarator.childForFieldName('name');
      if (!nameNode) continue;

      const name = nameNode.text;
      const value = declarator.childForFieldName('value');
      const isExported = this.hasExportDecorator(node);
      let entityType: EntityType = EntityType.VARIABLE;

      if (value) {
        if (value.type === 'arrow_function' || value.type === 'function' || value.type === 'function_expression') {
          entityType = EntityType.FUNCTION;
        }
      }

      const entity = this.createEntity(name, ctx, entityType, declarator, isExported);
      if (entity) {
        entities.push(entity);

        if (isExported) {
          relationships.push(this.createExportRel(ctx.filePath, entity.stableId, node));
        }

        // Extract calls from variable initializer
        if (value) {
          this.extractCallsFromNode(value, entity.stableId, ctx, relationships);
        }
      }
    }
  }

  private extractMethod(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[],
    classStableId?: string
  ): void {
    const nameNode = this.findChildByType(node, 'identifier') || node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const entity = this.createEntity(name, ctx, EntityType.METHOD, node, false);
    if (entity) {
      entities.push(entity);

      // Add CONTAINS relationship to parent class
      if (classStableId) {
        relationships.push(this.createContainsRel(classStableId, entity.stableId, ctx.filePath, node));
      }

      // Extract calls from method body
      this.extractCallsFromNode(node, entity.stableId, ctx, relationships);
    }
  }

  private extractConstructor(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[],
    classStableId: string
  ): void {
    const entity = this.createEntity('constructor', ctx, EntityType.CONSTRUCTOR, node, false);
    if (entity) {
      entities.push(entity);

      // Add CONTAINS relationship to parent class
      relationships.push(this.createContainsRel(classStableId, entity.stableId, ctx.filePath, node));

      // Extract calls from constructor body
      this.extractCallsFromNode(node, entity.stableId, ctx, relationships);
    }
  }

  private extractProperty(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[],
    classStableId?: string
  ): void {
    const nameNode = this.findChildByType(node, 'identifier') || node.children?.[0];
    if (!nameNode) return;

    const name = nameNode.text;
    const entity = this.createEntity(name, ctx, EntityType.PROPERTY, node, false);
    if (entity) {
      entities.push(entity);

      // Add CONTAINS relationship to parent class
      if (classStableId) {
        relationships.push(this.createContainsRel(classStableId, entity.stableId, ctx.filePath, node));
      }
    }
  }

  private extractImport(
    node: any,
    ctx: ExtractorContext,
    relationships: Relationship[]
  ): void {
    const sourceNode = node.childForFieldName('source');
    if (!sourceNode) return;

    const importPath = sourceNode.text.replace(/['"]/g, '');
    relationships.push(this.createImportRel(ctx.filePath, importPath, node, 1.0));

    const importClause = this.findChildByType(node, 'import_clause');
    if (importClause) {
      const namedImports = this.descendantsOfType(importClause, 'import_specifier');
      for (const spec of namedImports) {
        // Use the local alias when present: `import { helper as h }` binds `h`.
        const nameNode = spec.childForFieldName('alias') ?? spec.childForFieldName('name');
        if (!nameNode) continue;
        const symbol = nameNode.text;
        relationships.push(this.createImportSymbolRel(ctx.filePath, symbol, importPath, node));
      }

      const namespace = this.descendantsOfType(importClause, 'namespace_import')[0];
      if (namespace) {
        const alias = this.findChildByType(namespace, 'identifier') || namespace.childForFieldName('name');
        if (alias) {
          relationships.push(this.createImportSymbolRel(ctx.filePath, alias.text, importPath, node));
        }
      }

      const defaultImport = this.findChildByType(importClause, 'identifier');
      if (defaultImport && importClause.type !== 'import_specifier') {
        relationships.push(this.createImportSymbolRel(ctx.filePath, defaultImport.text, importPath, node));
      }
    }
  }

  private extractRequire(
    node: any,
    ctx: ExtractorContext,
    relationships: Relationship[]
  ): void {
    const args = node.children?.filter((c: any) => c.type === 'string' || c.type === 'template_string') || [];
    for (const arg of args) {
      const importPath = arg.text.replace(/['"`]/g, '');
      relationships.push(this.createImportRel(ctx.filePath, importPath, node, 0.9));
    }
  }

  private extractExpressionStatement(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const expression = node.children?.[0];
    if (!expression) return;

    // CommonJS requires: `require('fs')` / `const x = require('pkg')`.
    // tree-sitter parses these as call_expression (no import_require_clause).
    if (expression.type === 'call_expression') {
      const callee = expression.children?.[0];
      if (callee && callee.type === 'identifier' && callee.text === 'require') {
        this.extractRequire(expression, ctx, relationships);
        return;
      }
    }

    // Check for test blocks: describe(), it(), test()
    if (expression.type === 'call_expression') {
      const callee = expression.children?.[0];
      if (callee) {
        const calleeName = callee.text;
        
        // Detect test suite (describe, context, suite)
        if (this.isTestSuite(calleeName)) {
          this.extractTestBlock(expression, ctx, entities, relationships, EntityType.TEST_SUITE);
          return;
        }
        
        // Detect test case (it, test, should)
        if (this.isTestFunction(calleeName) && calleeName !== 'expect') {
          this.extractTestBlock(expression, ctx, entities, relationships, EntityType.TEST);
          return;
        }

        // Detect API endpoints (app.get, router.post, etc.)
        if (this.isApiEndpoint(callee)) {
          this.extractApiEndpoint(expression, ctx, entities, relationships);
          return;
        }
      }
    }
  }

  // Route registrations are only meaningful when called on a known router
  // object. Without this, any `x.get('key')`/`config.use(...)` would be
  // misclassified as an HTTP endpoint.
  private isApiEndpoint(callee: any): boolean {
    if (!callee || callee.type !== 'member_expression') return false;

    const children = callee.children || [];
    const receiver = children[0];
    const property = children[children.length - 1];
    if (!receiver || !property) return false;

    const method = property.type === 'property_identifier' || property.type === 'identifier'
      ? property.text
      : null;
    if (!method || !/^(get|post|put|patch|delete|all|use|route)$/.test(method)) return false;

    const receiverName = receiver.type === 'identifier' ? receiver.text : null;
    if (!receiverName) return false;

    const ROUTER_OBJECTS = new Set([
      'app', 'router', 'server', 'route', 'api', 'bp', 'blueprint',
      'express', 'fastify', 'koa', 'hono', 'namespace', 'endpoint',
      'this', 'routes', 'routerApp', 'authRouter', 'mainRouter', 'appRouter', 'apiRouter',
    ]);
    return ROUTER_OBJECTS.has(receiverName);
  }

  private extractApiEndpoint(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const children = node.children || [];
    const callee = children[0];
    if (!callee) return;

    const calleeText = callee.text;

    // Route arguments are wrapped in an `arguments` node in TS/JS.
    const argsNode = children.find((c: any) => c.type === 'arguments');
    const args = argsNode ? (argsNode.children || []) : children;

    // Get the route path from the first string argument
    const pathNode = args.find((c: any) => c.type === 'string' || c.type === 'template_string');
    if (!pathNode) return;

    const routePath = pathNode.text.replace(/['"]/g, '');

    let method = 'GET';

    if (calleeText.includes('.post')) method = 'POST';
    else if (calleeText.includes('.put')) method = 'PUT';
    else if (calleeText.includes('.patch')) method = 'PATCH';
    else if (calleeText.includes('.delete')) method = 'DELETE';
    else if (calleeText.includes('.all')) method = 'ALL';
    else if (calleeText.includes('.use')) method = 'MIDDLEWARE';

    const name = `${method} ${routePath}`;
    const entity = this.createEntity(name, ctx, EntityType.API_ENDPOINT, node, false);

    if (entity) {
      entities.push(entity);

      // Add EXPOSES relationship from file to endpoint
      relationships.push(this.createExportRel(ctx.filePath, entity.stableId, node));

      // HANDLES relationship to the handler (named symbol or inline function)
      const handlerNode = args.find(
        (c: any) =>
          c.type === 'arrow_function' ||
          c.type === 'function' ||
          c.type === 'function_expression' ||
          c.type === 'identifier'
      );
      this.extractRouteHandler(entity, handlerNode, ctx, entities, relationships);
    }
  }

  private extractRouteHandler(
    endpointEntity: Entity,
    handlerNode: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    if (!handlerNode) return;

    if (handlerNode.type === 'identifier') {
      // Named handler: bare-name target, resolved to a real stable ID later
      relationships.push(this.createHandlesRel(endpointEntity.stableId, handlerNode.text, ctx.filePath, handlerNode));
      return;
    }

    // Inline function: promote it to a real entity so the endpoint's body is traceable
    const handlerEntity = this.createEntity(
      `${endpointEntity.name} handler`,
      ctx,
      EntityType.FUNCTION,
      handlerNode,
      false
    );
    if (!handlerEntity) return;

    entities.push(handlerEntity);
    relationships.push(this.createContainsRel(endpointEntity.stableId, handlerEntity.stableId, ctx.filePath, handlerNode));
    relationships.push(this.createHandlesRel(endpointEntity.stableId, handlerEntity.stableId, ctx.filePath, handlerNode));
    this.extractCallsFromNode(handlerNode, handlerEntity.stableId, ctx, relationships);
  }

  private extractTestBlock(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[],
    entityType: EntityType
  ): void {
    // The name string lives inside an `arguments` child of the call_expression.
    const argsNode = (node.children || []).find((c: any) => c.type === 'arguments');
    const args = argsNode ? argsNode.children : (node.children || []);
    const nameNode = args.find((c: any) => c.type === 'string' || c.type === 'template_string');

    if (!nameNode) return;
    
    const name = nameNode.text.replace(/['"]/g, '');
    const entity = this.createEntity(name, ctx, entityType, node, false);
    
    if (entity) {
      entities.push(entity);
      
      // Extract calls from the test body
      this.extractCallsFromNode(node, entity.stableId, ctx, relationships);
    }
  }

  private extractCallsFromNode(
    node: any,
    callerStableId: string,
    ctx: ExtractorContext,
    relationships: Relationship[]
  ): void {
    // Find all call expressions in the node
    const callExpressions = this.descendantsOfType(node, 'call_expression');
    
    for (const call of callExpressions) {
      const callee = call.children?.[0];
      if (!callee) continue;

      let calleeName: string | null = null;
      
      if (callee.type === 'identifier') {
        calleeName = callee.text;
      } else if (callee.type === 'member_expression') {
        // For member expressions like obj.method, use the full expression
        calleeName = callee.text;
      }

      if (calleeName) {
        relationships.push(this.createCallsRel(callerStableId, calleeName, ctx.filePath, call));
      }
    }
  }
}
