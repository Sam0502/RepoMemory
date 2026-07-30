export { TreeSitterParser, getLanguageFromFilePath, shouldParseFile, PARSER_CONFIGS } from './parser.js';
export type { ParserConfig } from './parser.js';
export { initTreeSitter, createParser, getGrammarBytes } from './tree-sitter-init.js';
export {
  configureEmbeddings,
  embed,
  embedBatch,
  generateEntityEmbedding,
  getProviderName,
  getEmbeddingDimensions,
} from './embeddings.js';
export {
  OnnxEmbeddingProvider,
  GeminiEmbeddingProvider,
  PlaceholderEmbeddingProvider,
  createEmbeddingProvider,
} from './embedding/index.js';
export { normalizeToDimensions, l2Normalize, TARGET_DIMENSIONS } from './embedding/normalize.js';
export type { EmbeddingProvider, EmbeddingConfig, ProviderName } from './embedding/provider.js';
