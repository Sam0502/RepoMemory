import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

let initialized = false;
let ParserClass: any = null;

const GRAMMAR_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  python: 'tree-sitter-python.wasm',
};

async function loadParser(): Promise<any> {
  if (ParserClass) return ParserClass;
  const mod: any = await import('web-tree-sitter');
  ParserClass = mod.default || mod.Parser || mod;
  return ParserClass;
}

export async function initTreeSitter(): Promise<void> {
  if (initialized) return;
  const Parser = await loadParser();
  await Parser.init();
  initialized = true;
}

export function createParser(): any {
  if (!ParserClass) throw new Error('Tree-sitter not initialized');
  return new ParserClass();
}

export async function getGrammarBytes(grammarKey: string): Promise<Uint8Array> {
  const fileName = GRAMMAR_FILES[grammarKey];
  if (!fileName) throw new Error(`Unknown grammar: ${grammarKey}`);
  const wasmUrl = await import.meta.resolve(`tree-sitter-wasms/out/${fileName}`);
  const filePath = fileURLToPath(wasmUrl);
  return new Uint8Array(await readFile(filePath));
}
