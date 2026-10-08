import { Entity, Relationship, EntityType, RelationshipType, Language } from '@repo-memory/shared';
import { ExtractorContext } from './interface.js';
import { BaseExtractor } from './base.js';
import { generateFileStableId } from '../resolver/ids.js';

const ROUTER_OBJECTS = new Set([
  'app', 'router', 'route', 'api', 'bp', 'blueprint', 'server',
  'fastapi', 'flask', 'endpoint', 'main', 'app_router', 'api_router',
  'auth', 'admin', 'user_routes', 'routes', 'this',
]);

export class PythonExtractor extends BaseExtractor {
  language = Language.PYTHON;

  extractNodes(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nodeType = node.type;

    switch (nodeType) {
      case 'function_definition':
        this.extractFunction(node, ctx, entities, relationships);
        break;
      case 'class_definition':
        this.extractClass(node, ctx, entities, relationships);
        break;
      case 'decorated_definition':
        this.extractDecoratedDefinition(node, ctx, entities, relationships);
        break;
      case 'import_statement':
        this.extractImport(node, ctx, relationships);
        break;
      case 'import_from_statement':
        this.extractImportFrom(node, ctx, relationships);
        break;
      case 'assignment':
        this.extractAssignment(node, ctx, entities, relationships);
        break;
      case 'expression_statement':
        this.extractExpressionStatement(node, ctx, entities, relationships);
        break;
    }

    for (const child of node.children) {
      // decorated_definition already handles its wrapped function/class
      if (nodeType === 'decorated_definition' &&
          (child.type === 'function_definition' || child.type === 'class_definition')) {
        continue;
      }
      // class_definition already extracts its body via extractClass —
      // skip the block to avoid duplicate METHOD entities.
      if (nodeType === 'class_definition' && (child.type === 'block' || child.type === 'function_definition' || child.type === 'assignment' || child.type === 'decorated_definition')) {
        continue;
      }
      this.extractNodes(child, ctx, entities, relationships);
    }
  }

  private extractFunction(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[],
    parentClassStableId?: string
  ): Entity | null {
    const nameNode = this.findChildByType(node, 'identifier') || node.childForFieldName('name');
    if (!nameNode) return null;

    const name = nameNode.text;
    const isExported = this.isExported(name);
    const isDunder = name.startsWith('__') && name.endsWith('__');

    // Determine entity type
    let entityType: EntityType = EntityType.FUNCTION;
    if (isDunder && name === '__init__') {
      entityType = EntityType.CONSTRUCTOR;
    } else if (parentClassStableId) {
      entityType = EntityType.METHOD;
    } else if (/^describe_/.test(name)) {
      // pytest-describe style blocks
      entityType = EntityType.TEST_SUITE;
    } else if (/^it_/.test(name) || (this.isTestFile(ctx.filePath) && this.isTestFunction(name))) {
      entityType = EntityType.TEST;
    }

    const entity = this.createEntity(name, ctx, entityType, node, isExported);
    if (entity) {
      entities.push(entity);

      // Add CONTAINS relationship to parent class
      if (parentClassStableId) {
        relationships.push(this.createContainsRel(parentClassStableId, entity.stableId, ctx.filePath, node));
      }

      // Extract function calls from the function body
      this.extractCallsFromNode(node, entity.stableId, ctx, relationships);
      
      // Extract references from the function body
      this.extractReferencesFromNode(node, entity.stableId, ctx, relationships);

      // Extract docstring
      this.extractDocstring(node, entity, ctx);

      return entity;
    }

    return null;
  }

  private extractClass(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const nameNode = this.findChildByType(node, 'identifier') || node.childForFieldName('name');
    if (!nameNode) return;

    const name = nameNode.text;
    const isExported = this.isExported(name);

    const entity = this.createEntity(
      name,
      ctx,
      this.isModelClass(name, node) ? EntityType.MODEL : EntityType.CLASS,
      node,
      isExported
    );
    if (entity) {
      entities.push(entity);

      // Extract base classes (inheritance)
      const superclasses = this.findChildByType(node, 'argument_list');
      if (superclasses) {
        for (const arg of superclasses.children) {
          if (arg.type === 'identifier' || arg.type === 'attribute') {
            const parentName = arg.text;
            relationships.push(this.createHeritageRel(
              entity.stableId, parentName, RelationshipType.EXTENDS, ctx.filePath, node
            ));
          }
        }
      }

      // Extract class body
      const body = this.findChildByType(node, 'block') || node.childForFieldName('body');
      if (body) {
        for (const child of body.children) {
          if (child.type === 'function_definition') {
            this.extractFunction(child, ctx, entities, relationships, entity.stableId);
          } else if (child.type === 'assignment') {
            this.extractClassVariable(child, ctx, entities, relationships, entity.stableId);
          } else if (child.type === 'decorated_definition') {
            this.extractDecoratedDefinition(child, ctx, entities, relationships, entity.stableId);
          }
        }
      }

      // Extract docstring
      this.extractDocstring(node, entity, ctx);
    }
  }

  private extractDecoratedDefinition(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[],
    parentClassStableId?: string
  ): void {
    // Get the decorated definition (function, class, etc.)
    const definition = node.children?.find((c: any) => 
      c.type === 'function_definition' || 
      c.type === 'class_definition'
    );
    
    let handlerEntity: Entity | null = null;
    if (definition) {
      if (definition.type === 'function_definition') {
        handlerEntity = this.extractFunction(definition, ctx, entities, relationships, parentClassStableId);
      } else if (definition.type === 'class_definition') {
        this.extractClass(definition, ctx, entities, relationships);
      }
    }

    // Detect route decorators (@app.route('/x'), @app.get('/x')) and link
    // each endpoint to the wrapped handler via HANDLES
    const decorators = this.findChildrenByType(node, 'decorator');
    for (const decorator of decorators) {
      const call = decorator.children?.find((c: any) => c.type === 'call');
      if (call) {
        this.extractRouteDecorator(call, handlerEntity, ctx, entities, relationships);
      }
    }
  }

  private extractRouteDecorator(
    callNode: any,
    handlerEntity: Entity | null,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    const functionNode = callNode.children?.[0];
    if (!functionNode || functionNode.type !== 'attribute') return;

    const receiverName = this.getAttributeReceiver(functionNode);
    if (!receiverName || !ROUTER_OBJECTS.has(receiverName)) return;

    const methodNode = this.findChildrenByType(functionNode, 'identifier').pop();
    const methodName = methodNode?.text;
    if (!methodName) return;

    // Flask/FastAPI route patterns
    const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'route'];
    if (!httpMethods.includes(methodName)) return;

    const argsNode = callNode.children?.[1];
    if (!argsNode || argsNode.type !== 'argument_list') return;

    const pathNode = argsNode.children?.find((c: any) => c.type === 'string' || c.type === 'concatenated_string');
    if (!pathNode) return;

    const routePath = pathNode.text.replace(/['"]/g, '');

    let method = 'GET';
    if (methodName === 'post') method = 'POST';
    else if (methodName === 'put') method = 'PUT';
    else if (methodName === 'patch') method = 'PATCH';
    else if (methodName === 'delete') method = 'DELETE';
    else if (methodName === 'route') {
      const methodArg = argsNode.children?.find((c: any) => 
        c.type === 'keyword_argument' && c.children?.[0]?.text === 'methods'
      );
      if (methodArg) {
        const methodsValue = methodArg.children?.[2]?.text?.replace(/[\]'"[]/g, '');
        if (methodsValue) {
          method = methodsValue.split(',')[0].trim().toUpperCase();
        }
      }
    }

    const name = `${method} ${routePath}`;
    const entity = this.createEntity(name, ctx, EntityType.API_ENDPOINT, callNode, false);

    if (entity) {
      entities.push(entity);

      // Add EXPOSES relationship from file to endpoint
      relationships.push(this.createExportRel(ctx.filePath, entity.stableId, callNode));

      // HANDLES: endpoint -> wrapped handler function
      if (handlerEntity) {
        relationships.push(this.createHandlesRel(entity.stableId, handlerEntity.stableId, ctx.filePath, callNode));
      }
    }
  }

  private extractImport(
    node: any,
    ctx: ExtractorContext,
    relationships: Relationship[]
  ): void {
    // import module
    // import module.submodule
    // import module as alias
    const modules = this.findChildrenByType(node, 'dotted_name');
    
    for (const module of modules) {
      const importPath = module.text;
      relationships.push(this.createImportRel(ctx.filePath, importPath, node, 1.0));
    }
  }

  private extractImportFrom(
    node: any,
    ctx: ExtractorContext,
    relationships: Relationship[]
  ): void {
    // from module import name
    // from module import name1, name2
    // from module import *
    
    const sourceNode = this.findChildByType(node, 'dotted_name') || 
                       this.findChildByType(node, 'relative_import');
    if (!sourceNode) return;
    
    const importPath = sourceNode.text;
    relationships.push(this.createImportRel(ctx.filePath, importPath, node, 1.0));
    
    // Get imported names
    const importedNames = this.findChildByType(node, 'import_list');
    if (importedNames) {
      for (const child of importedNames.children) {
        if (child.type === 'dotted_name' || child.type === 'identifier') {
          const symbol = child.text;
          relationships.push(this.createImportSymbolRel(ctx.filePath, symbol, importPath, node));
        } else if (child.type === 'aliased_import') {
          // `from x import y as z` binds z locally — store the alias.
          const ids = (child.children || []).filter((c: any) => c.type === 'identifier' || c.type === 'dotted_name');
          const aliasNode = ids[ids.length - 1];
          if (aliasNode) {
            relationships.push(this.createImportSymbolRel(ctx.filePath, aliasNode.text, importPath, node));
          }
        }
      }
    } else {
      // Wildcard import
      const wildcard = this.findChildByType(node, 'wildcard_import');
      if (wildcard) {
        relationships.push(this.createImportSymbolRel(ctx.filePath, '*', importPath, node));
      }
    }
  }

  private extractAssignment(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    // Only module-level names become entities. Locals inside functions,
    // lambdas, and classes would pollute exports and dead-code reports.
    if (!this.isModuleScope(node)) return;

    const leftNode = node.children?.[0];
    if (!leftNode) return;

    // Only handle simple assignments (variable = value)
    if (leftNode.type !== 'identifier') return;
    
    const name = leftNode.text;
    const isExported = this.isExported(name);
    
    // Check if the value is a function (lambda or function call)
    const rightNode = node.children?.[2];
    let entityType: EntityType = EntityType.VARIABLE;
    
    if (rightNode) {
      if (rightNode.type === 'lambda' || rightNode.type === 'function') {
        entityType = EntityType.FUNCTION;
      }
    }

    const entity = this.createEntity(name, ctx, entityType, node, isExported);
    if (entity) {
      entities.push(entity);

      // Extract calls from the value
      if (rightNode) {
        this.extractCallsFromNode(rightNode, entity.stableId, ctx, relationships);
      }
    }
  }

  private isModuleScope(node: any): boolean {
    let current = node.parent;
    while (current) {
      if (
        current.type === 'function_definition' ||
        current.type === 'lambda' ||
        current.type === 'class_definition'
      ) {
        return false;
      }
      current = current.parent;
    }
    return true;
  }

  private extractClassVariable(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[],
    classStableId: string
  ): void {
    const leftNode = node.children?.[0];
    if (!leftNode || leftNode.type !== 'identifier') return;

    const name = leftNode.text;
    const entity = this.createEntity(name, ctx, EntityType.PROPERTY, node, false);
    if (entity) {
      entities.push(entity);
      relationships.push(this.createContainsRel(classStableId, entity.stableId, ctx.filePath, node));
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

    // Handle function calls in expression statements
    if (expression.type === 'call') {
      this.extractCallsFromNode(expression, generateFileStableId(ctx.repoPath, ctx.filePath), ctx, relationships);
      
      // Detect API endpoints (Flask/FastAPI decorators)
      this.extractApiEndpoint(expression, ctx, entities, relationships);
    }
  }

  private extractApiEndpoint(
    node: any,
    ctx: ExtractorContext,
    entities: Entity[],
    relationships: Relationship[]
  ): void {
    // Check if this is a route registration call
    const functionNode = node.children?.[0];
    if (!functionNode || functionNode.type !== 'attribute') return;

    // Only treat calls on known router objects (app.get, router.post, bp.get)
    // as endpoints; `dict.get('k')` / `requests.get(...)` are not routes.
    const receiverName = this.getAttributeReceiver(functionNode);
    if (!receiverName || !ROUTER_OBJECTS.has(receiverName)) return;
    
    const methodNode = this.findChildrenByType(functionNode, 'identifier').pop();
    const methodName = methodNode?.text;
    if (!methodName) return;
    
    // Flask/FastAPI route patterns
    const httpMethods = ['get', 'post', 'put', 'patch', 'delete', 'route'];
    if (!httpMethods.includes(methodName)) return;
    
    // Get the route path from the first string argument
    const argsNode = node.children?.[1];
    if (!argsNode || argsNode.type !== 'argument_list') return;
    
    const pathNode = argsNode.children?.find((c: any) => c.type === 'string' || c.type === 'concatenated_string');
    if (!pathNode) return;
    
    const routePath = pathNode.text.replace(/['"]/g, '');
    
    // Determine the HTTP method
    let method = 'GET';
    if (methodName === 'post') method = 'POST';
    else if (methodName === 'put') method = 'PUT';
    else if (methodName === 'patch') method = 'PATCH';
    else if (methodName === 'delete') method = 'DELETE';
    else if (methodName === 'route') {
      // For @app.route(), try to determine method from arguments
      const methodArg = argsNode.children?.find((c: any) => 
        c.type === 'keyword_argument' && c.children?.[0]?.text === 'methods'
      );
      if (methodArg) {
        const methodsValue = methodArg.children?.[2]?.text?.replace(/[\]'"[]/g, '');
        if (methodsValue) {
          method = methodsValue.split(',')[0].trim().toUpperCase();
        }
      }
    }
    
    const name = `${method} ${routePath}`;
    const entity = this.createEntity(name, ctx, EntityType.API_ENDPOINT, node, false);
    
    if (entity) {
      entities.push(entity);
      
      // Add EXPOSES relationship from file to endpoint
      relationships.push(this.createExportRel(ctx.filePath, entity.stableId, node));

      // HANDLES: endpoint -> named handler (bare name, resolved later)
      const handlerNode = argsNode.children?.find((c: any) => c.type === 'identifier');
      if (handlerNode) {
        relationships.push(this.createHandlesRel(entity.stableId, handlerNode.text, ctx.filePath, handlerNode));
      }
    }
  }

  private isExported(name: string): boolean {
    // In Python, all top-level names are effectively exported
    // unless prefixed with underscore
    return !name.startsWith('_');
  }

  // For an attribute node like `app.get` (or `blueprint.route`), return the
  // receiver object name (`app` / `blueprint`).
  private getAttributeReceiver(attributeNode: any): string | null {
    const children = attributeNode.children || [];
    const receiver = children[0];
    if (!receiver) return null;
    if (receiver.type === 'identifier') return receiver.text;
    if (receiver.type === 'attribute') return this.getAttributeReceiver(receiver);
    return null;
  }

  private extractDocstring(node: any, entity: Entity, _ctx: ExtractorContext): void {
    // Extract docstring from function/class body
    const body = this.findChildByType(node, 'block') || node.childForFieldName('body');
    if (!body) return;

    const firstStatement = body.children?.[0];
    if (!firstStatement) return;

    // Check for expression statement containing a string
    if (firstStatement.type === 'expression_statement') {
      const expression = firstStatement.children?.[0];
      if (expression && (expression.type === 'string' || expression.type === 'concatenated_string')) {
        const raw = expression.text.trim();
        // Strip only the outer quote delimiters (single, double, or triple),
        // preserving quotes/apostrophes inside the docstring content.
        const match = raw.match(/^('''|"""|'|")([\s\S]*?)\1$/);
        const docstring = match ? match[2] : raw.replace(/^['"]/, '').replace(/['"]$/, '');
        if (docstring.trim()) {
          entity.docstring = docstring.trim();
        }
      }
    }
  }

  private extractCallsFromNode(
    node: any,
    callerStableId: string,
    ctx: ExtractorContext,
    relationships: Relationship[]
  ): void {
    // Find all call expressions in the node
    const callExpressions = this.descendantsOfType(node, 'call');
    
    for (const call of callExpressions) {
      const functionNode = call.children?.[0];
      if (!functionNode) continue;

      let calleeName: string | null = null;
      
      if (functionNode.type === 'identifier') {
        calleeName = functionNode.text;
      } else if (functionNode.type === 'attribute') {
        // For attribute access like obj.method
        calleeName = functionNode.text;
      }

      if (calleeName) {
        relationships.push(this.createCallsRel(callerStableId, calleeName, ctx.filePath, call));
      }
    }
  }
}
