import { Language, ParseResult, Entity, Relationship, EntityType } from '@repo-memory/shared';
import { initTreeSitter, createParser, getGrammarBytes } from './tree-sitter-init.js';
import { LanguageExtractor, ExtractorContext, TypeScriptExtractor, JavaScriptExtractor, PythonExtractor } from './extractors/index.js';
import { createHash } from 'crypto';

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
  python: {
    language: Language.PYTHON,
    grammarKey: 'python',
    fileExtensions: ['.py', '.pyw'],
  },
};

const LANGUAGE_EXTRACTORS: Record<string, () => LanguageExtractor> = {
  [Language.TYPESCRIPT]: () => new TypeScriptExtractor(),
  [Language.JAVASCRIPT]: () => new JavaScriptExtractor(),
  [Language.PYTHON]: () => new PythonExtractor(),
};

export class TreeSitterParser {
  private language: Language;
  private grammarKey: string;
  private extractor: LanguageExtractor;
  private tsParser: any = null;

  constructor(language: Language, grammarKey?: string) {
    this.language = language;
    this.grammarKey = grammarKey || this.resolveGrammarKey(language);
    this.extractor = this.createExtractor(language);
  }

  getGrammarKey(): string {
    return this.grammarKey;
  }

  private resolveGrammarKey(language: Language): string {
    // Look up grammar key from PARSER_CONFIGS based on language
    for (const config of Object.values(PARSER_CONFIGS)) {
      if (config.language === language) {
        return config.grammarKey;
      }
    }
    // Default fallback
    if (language === Language.JAVASCRIPT) return 'javascript';
    if (language === Language.PYTHON) return 'python';
    return 'typescript';
  }

  private createExtractor(language: Language): LanguageExtractor {
    const factory = LANGUAGE_EXTRACTORS[language];
    if (factory) {
      return factory();
    }
    // Default to TypeScript extractor
    return new TypeScriptExtractor();
  }

  async initialize(): Promise<void> {
    await initTreeSitter();
    this.tsParser = createParser();

    const grammarBytes = await getGrammarBytes(this.grammarKey);

    const mod: any = await import('web-tree-sitter');
    const TreeSitterLanguage = mod.default?.Language || mod.Language;
    const wasmModule = await TreeSitterLanguage.load(grammarBytes);
    this.tsParser.setLanguage(wasmModule);
  }

  async parse(filePath: string, content: string, repoPath: string = ''): Promise<ParseResult> {
    const entities: Entity[] = [];
    const relationships: Relationship[] = [];
    const errors: ParseResult['errors'] = [];

    // Check for config files
    if (this.isConfigFile(filePath)) {
      const configEntity = this.createConfigEntity(filePath, repoPath);
      if (configEntity) {
        entities.push(configEntity);
      }
      // Pure config files (package.json, Dockerfile, .env) aren't valid AST
      // source; skip the tree-sitter pass. Code-based configs (vite.config.ts,
      // jest.config.js) fall through and are parsed normally too.
      if (!shouldParseFile(filePath)) {
        return { filePath, language: this.language, entities, relationships, errors };
      }
    }

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

      try {
        const rootNode = tree.rootNode;
        const ctx: ExtractorContext = { filePath, content, language: this.language, repoPath };
        this.extractor.extractNodes(rootNode, ctx, entities, relationships);
      } finally {
        // Free the WASM-allocated tree to avoid an unbounded leak in long-lived
        // watch/serve processes.
        tree.delete();
      }
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

  private isConfigFile(filePath: string): boolean {
    return isConfigFilePath(filePath);
  }

  private createConfigEntity(filePath: string, repoPath: string = ''): Entity | null {
    const fileName = filePath.split(/[\\/]/).pop() || filePath;
    const name = fileName.replace(/\.[^.]+$/, '') || fileName;
    
    const stableId = createHash('md5').update(`config:${repoPath}:${filePath}:${name}`).digest('hex');
    
    return {
      id: stableId,
      stableId,
      name,
      type: EntityType.CONFIG,
      language: this.language,
      filePath,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      isTest: false,
      confidence: 1.0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
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
    case 'py':
    case 'pyw':
      return Language.PYTHON;
    default:
      return Language.UNKNOWN;
  }
}

export function languageFromGrammarKey(grammarKey: string): Language {
  switch (grammarKey) {
    case 'javascript':
    case 'jsx':
      return Language.JAVASCRIPT;
    case 'python':
      return Language.PYTHON;
    case 'typescript':
    case 'tsx':
    default:
      return Language.TYPESCRIPT;
  }
}

export function getGrammarKeyFromFilePath(filePath: string): string {  const ext = filePath.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
    case 'pyw':
      return 'python';
    default:
      return 'typescript';
  }
}

export function shouldParseFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'pyw'].includes(ext || '');
}

export function isConfigFilePath(filePath: string): boolean {
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

export function registerLanguageExtractor(language: Language, factory: () => LanguageExtractor): void {
  LANGUAGE_EXTRACTORS[language] = factory;
}
