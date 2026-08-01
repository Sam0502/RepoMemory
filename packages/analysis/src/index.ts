export { TreeSitterParser, getLanguageFromFilePath, shouldParseFile, isConfigFilePath, getGrammarKeyFromFilePath, PARSER_CONFIGS, registerLanguageExtractor } from './parser.js';
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
export type { LanguageExtractor, ExtractorContext } from './extractors/index.js';
export { BaseExtractor, TypeScriptExtractor, JavaScriptExtractor, PythonExtractor } from './extractors/index.js';
export { SymbolIndex, RelationshipResolver, generateEntityStableId, generateFileStableId, createFileEntity, resolveImportPath } from './resolver/index.js';
export type { SymbolDefinition, ResolvedSymbol } from './resolver/index.js';
export { detectDeadCode } from './deadcode.js';
export type { DeadCodeReport, DeadCodeItem } from './deadcode.js';
export { inferDomain, inferArchitecturalRole, applyDomainMetadata, parseDomainConfig } from './domain.js';
export type { DomainConfig, DomainConfigDomain } from './domain.js';
export { validateBoundaries } from './boundaries.js';
export type { BoundaryReport, BoundaryViolation, BoundaryEndpoint, DomainSummary } from './boundaries.js';
