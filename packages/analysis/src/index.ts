export { TreeSitterParser, getLanguageFromFilePath, shouldParseFile, isConfigFilePath, getGrammarKeyFromFilePath, languageFromGrammarKey, PARSER_CONFIGS } from './parser.js';
export type { ParserConfig } from './parser.js';
export { initTreeSitter, createParser, getGrammarBytes } from './tree-sitter-init.js';
export {
  configureEmbeddings,
  initializeEmbeddings,
  embed,
  embedBatch,
  generateEntityEmbedding,
  generateEntityEmbeddings,
  getProviderName,
  getProviderSignature,
  getEmbeddingDimensions,
} from './embeddings.js';
export {
  OnnxEmbeddingProvider,
  GeminiEmbeddingProvider,
  PlaceholderEmbeddingProvider,
  createEmbeddingProvider,
} from './embedding/index.js';
export { normalizeToDimensions, TARGET_DIMENSIONS } from './embedding/normalize.js';
export type { EmbeddingProvider, EmbeddingConfig, ProviderName } from './embedding/provider.js';
export type { LanguageExtractor, ExtractorContext } from './extractors/index.js';
export { BaseExtractor, TypeScriptExtractor, JavaScriptExtractor, PythonExtractor } from './extractors/index.js';
export { SymbolIndex, RelationshipResolver, generateEntityStableId, generateFileStableId, createFileEntity, resolveImportPath } from './resolver/index.js';
export type { SymbolDefinition, ResolvedSymbol } from './resolver/index.js';
export { detectDeadCode, isDeadCodeRoot, RELEVANT_TYPES } from './deadcode.js';
export type { DeadCodeReport, DeadCodeItem } from './deadcode.js';
export { inferDomain, inferArchitecturalRole, applyDomainMetadata, parseDomainConfig } from './domain.js';
export type { DomainConfig, DomainConfigDomain } from './domain.js';
export { validateBoundaries } from './boundaries.js';
export type { BoundaryReport, BoundaryViolation, BoundaryEndpoint, DomainSummary } from './boundaries.js';
export { streamDeadCode, streamBoundaries, resolveBatchSize, DEFAULT_BATCH_SIZE } from './streaming.js';
export type { PagedSource, StreamOptions } from './streaming.js';
export { ChangeAnalyzer } from './change.js';
export type { ChangeDataProvider, FileChurn, FileRisk, RiskBreakdown, EntityChangeInfo, DriftReport, DriftSignal } from './change.js';
