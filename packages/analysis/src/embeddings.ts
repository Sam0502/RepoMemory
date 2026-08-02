import {
  EmbeddingProvider,
  EmbeddingConfig,
  OnnxEmbeddingProvider,
  GeminiEmbeddingProvider,
  PlaceholderEmbeddingProvider,
} from './embedding/index.js';
import { normalizeToDimensions, TARGET_DIMENSIONS } from './embedding/normalize.js';
import { getLogger, metrics, registerDefaultMetrics } from '@repo-memory/shared';

const logger = getLogger({ component: 'embeddings' });
registerDefaultMetrics();

let currentProvider: EmbeddingProvider | null = null;
let fallbackProvider: EmbeddingProvider | null = null;

export function configureEmbeddings(config: EmbeddingConfig, fallback?: EmbeddingConfig): void {
  currentProvider = createProvider(config);

  if (fallback && fallback.provider !== config.provider) {
    try {
      fallbackProvider = createProvider(fallback);
    } catch {
      fallbackProvider = null;
    }
  } else {
    fallbackProvider = null;
  }
}

function createProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'onnx':
      return new OnnxEmbeddingProvider(
        config.onnx?.modelId || 'Xenova/all-MiniLM-L6-v2',
        config.onnx?.cacheDir
      );
    case 'gemini':
      if (!config.gemini?.apiKey) {
        throw new Error('Gemini API key required');
      }
      return new GeminiEmbeddingProvider({
        apiKey: config.gemini.apiKey,
        model: config.gemini.model,
      });
    case 'placeholder':
    default:
      return new PlaceholderEmbeddingProvider();
  }
}

export async function embed(text: string): Promise<number[]> {
  metrics.inc('repo_memory_embedding_calls_total');
  if (!currentProvider) {
    currentProvider = new PlaceholderEmbeddingProvider();
  }

  try {
    const raw = await currentProvider.embed(text);
    return normalizeToDimensions(raw, TARGET_DIMENSIONS);
  } catch (error) {
    logger.warn({ err: error, provider: currentProvider.name }, 'Primary embedding provider failed');
    if (fallbackProvider) {
      logger.info({ provider: fallbackProvider.name }, 'Falling back to fallback embedding provider');
      try {
        const raw = await fallbackProvider.embed(text);
        return normalizeToDimensions(raw, TARGET_DIMENSIONS);
      } catch (fallbackError) {
        logger.warn({ err: fallbackError, provider: fallbackProvider.name }, 'Fallback embedding provider also failed');
        throw error;
      }
    }
    throw error;
  }
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  metrics.inc('repo_memory_embedding_calls_total');
  if (!currentProvider) {
    currentProvider = new PlaceholderEmbeddingProvider();
  }

  try {
    const raw = await currentProvider.embedBatch(texts);
    return raw.map(v => normalizeToDimensions(v, TARGET_DIMENSIONS));
  } catch (error) {
    logger.warn({ err: error, provider: currentProvider.name }, 'Primary embedding provider failed batch');
    if (fallbackProvider) {
      logger.info({ provider: fallbackProvider.name }, 'Falling back to fallback embedding provider');
      try {
        const raw = await fallbackProvider.embedBatch(texts);
        return raw.map(v => normalizeToDimensions(v, TARGET_DIMENSIONS));
      } catch (fallbackError) {
        logger.warn({ err: fallbackError, provider: fallbackProvider.name }, 'Fallback embedding provider also failed');
        throw error;
      }
    }
    throw error;
  }
}

export function getProviderName(): string {
  return currentProvider?.name || 'placeholder';
}

export function getEmbeddingDimensions(): number {
  return TARGET_DIMENSIONS;
}

export function generateEntityEmbedding(
  name: string,
  type: string,
  filePath: string
): Promise<number[]> {
  const text = `${type}:${name}:${filePath}`;
  return embed(text);
}
