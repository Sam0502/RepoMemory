import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { TreeSitterParser } from '../src/parser.js';
import { Language, EntityType, RelationshipType } from '@repo-memory/shared';

// Vitest's SSR transform replaces import.meta.resolve with a non-function; stub
// getGrammarBytes to resolve the WASM grammar via createRequire instead.
vi.mock('../src/tree-sitter-init.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tree-sitter-init.js')>();
  const require = createRequire(import.meta.url);
  const GRAMMAR_FILES: Record<string, string> = {
    typescript: 'tree-sitter-typescript.wasm',
    javascript: 'tree-sitter-javascript.wasm',
    tsx: 'tree-sitter-tsx.wasm',
    python: 'tree-sitter-python.wasm',
  };
  return {
    ...actual,
    getGrammarBytes: async (grammarKey: string) => {
      const fileName = GRAMMAR_FILES[grammarKey];
      if (!fileName) throw new Error(`Unknown grammar: ${grammarKey}`);
      const filePath = require.resolve(`tree-sitter-wasms/out/${fileName}`);
      return new Uint8Array(await readFile(filePath));
    },
  };
});

const TS_SAMPLE = `
import { helper } from './helper';
import fs from 'fs';

export interface User {
  id: number;
  name: string;
}

export enum Status {
  Active = 'active',
}

export type UserId = string;

export class UserService {
  private users: User[] = [];

  constructor(private db: any) {}

  getUser(id: UserId): User | undefined {
    return this.users.find(u => u.id === Number(id));
  }

  static create(db: any): UserService {
    return new UserService(db);
  }
}

export function createUser(name: string): User {
  helper();
  return { id: 1, name };
}
`;

const PY_SAMPLE = `
import os
from collections import defaultdict

class BaseModel:
    pass

class UserModel(BaseModel):
    def __init__(self, name):
        self.name = name

    def get(self, uid):
        return self

def create_user(name):
    return UserModel(name)

@app.route('/users')
def list_users():
    return create_user('a')

def test_create_user():
    assert create_user('a').name == 'a'
`;

let tsParser: TreeSitterParser;
let pyParser: TreeSitterParser;

beforeAll(async () => {
  tsParser = new TreeSitterParser(Language.TYPESCRIPT);
  await tsParser.initialize();
  pyParser = new TreeSitterParser(Language.PYTHON);
  await pyParser.initialize();
});

describe('TypeScriptExtractor', () => {
  it('extracts classes, interfaces, enums, type aliases, and functions', async () => {
    const result = await tsParser.parse('src/user.ts', TS_SAMPLE, '/repo');
    const names = result.entities.map(e => e.name);
    expect(names).toContain('User');
    expect(names).toContain('Status');
    expect(names).toContain('UserId');
    expect(names).toContain('UserService');
    expect(names).toContain('createUser');
  });

  it('detects constructors, methods, and properties', async () => {
    const result = await tsParser.parse('src/user.ts', TS_SAMPLE, '/repo');
    const names = result.entities.map(e => e.name);
    expect(names).toContain('constructor');
    expect(names).toContain('getUser');
    expect(names).toContain('create');
    expect(result.entities.some(e => e.type === EntityType.PROPERTY)).toBe(true);
  });

  it('extracts import relationships', async () => {
    const result = await tsParser.parse('src/user.ts', TS_SAMPLE, '/repo');
    const imports = result.relationships.filter(r => r.type === RelationshipType.IMPORTS);
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const helperImport = imports.find(i => i.metadata?.importPath === './helper');
    expect(helperImport).toBeDefined();
  });

  it('extracts exported entities as exported', async () => {
    const result = await tsParser.parse('src/user.ts', TS_SAMPLE, '/repo');
    expect(result.entities.find(e => e.name === 'createUser')?.isExported).toBe(true);
  });

  it('tracks line positions', async () => {
    const result = await tsParser.parse('src/user.ts', TS_SAMPLE, '/repo');
    const user = result.entities.find(e => e.name === 'User')!;
    expect(user.startLine).toBeGreaterThan(0);
    expect(user.endLine).toBeGreaterThanOrEqual(user.startLine);
  });

  it('fills signature, docstring, and purpose from JSDoc', async () => {
    const sample = `/** Adds two numbers.
 * @param a first
 * @param b second
 */
export function add(a: number, b: number): number {
  return a + b;
}

/** A tiny calculator. */
export class Calculator {
  /** Divides x by y. Returns the quotient. */
  divide(x: number, y: number): number {
    return x / y;
  }
}
`;
    const result = await tsParser.parse('src/math.ts', sample, '/repo');
    const add = result.entities.find(e => e.name === 'add')!;
    expect(add.signature).toContain('function add(a: number, b: number): number');
    expect(add.docstring).toBe('Adds two numbers.');
    expect(add.purpose).toBe('Adds two numbers.');
    const calc = result.entities.find(e => e.name === 'Calculator')!;
    expect(calc.docstring).toBe('A tiny calculator.');
    const divide = result.entities.find(e => e.name === 'divide')!;
    expect(divide.signature).toContain('divide(x: number, y: number): number');
    expect(divide.docstring).toBe('Divides x by y. Returns the quotient.');
    expect(divide.purpose).toBe('Divides x by y.');
  });

  it('leaves docstring and purpose empty without comments', async () => {
    const result = await tsParser.parse('src/plain.ts', 'export function nodoc(): void {}\n', '/repo');
    const fn = result.entities.find(e => e.name === 'nodoc')!;
    expect(fn.signature).toContain('function nodoc()');
    expect(fn.docstring).toBeUndefined();
    expect(fn.purpose).toBeUndefined();
  });
});

describe('PythonExtractor', () => {
  it('extracts functions, classes, methods, and constructors', async () => {
    const result = await pyParser.parse('src/app.py', PY_SAMPLE, '/repo');
    const names = result.entities.map(e => e.name);
    expect(names).toContain('UserModel');
    expect(names).toContain('create_user');
    expect(names).toContain('list_users');
    expect(result.entities.some(e => e.type === EntityType.CONSTRUCTOR)).toBe(true);
  });

  it('detects model classes', async () => {
    const result = await pyParser.parse('src/app.py', PY_SAMPLE, '/repo');
    const model = result.entities.find(e => e.name === 'UserModel');
    expect(model?.type).toBe(EntityType.MODEL);
  });

  it('detects API endpoints from route decorators', async () => {
    const result = await pyParser.parse('src/app.py', PY_SAMPLE, '/repo');
    expect(result.entities.some(e => e.type === EntityType.API_ENDPOINT)).toBe(true);
  });

  it('detects test functions', async () => {
    const result = await pyParser.parse('src/app.py', PY_SAMPLE, '/repo');
    expect(result.entities.some(e => e.name === 'test_create_user')).toBe(true);
  });

  it('extracts imports and calls', async () => {
    const result = await pyParser.parse('src/app.py', PY_SAMPLE, '/repo');
    expect(result.relationships.some(r => r.type === RelationshipType.IMPORTS)).toBe(true);
    expect(result.relationships.some(r => r.type === RelationshipType.CALLS)).toBe(true);
  });
});

describe('Config file handling', () => {
  it('creates a CONFIG entity and skips the AST pass for non-source configs', async () => {
    const parser = new TreeSitterParser(Language.TYPESCRIPT);
    await parser.initialize();
    const result = await parser.parse('package.json', '{"name":"x"}', '/repo');
    expect(result.entities.some(e => e.type === EntityType.CONFIG)).toBe(true);
    expect(result.entities).toHaveLength(1);
  });
});
