import {
  EmbeddingProvider,
  EmbeddingConfig,
  OnnxEmbeddingProvider,
  GeminiEmbeddingProvider,
  PlaceholderEmbeddingProvider,
} from './embedding/index.js';
import { normalizeToDimensions, TARGET_DIMENSIONS } from './embedding/normalize.js';

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
  if (!currentProvider) {
    currentProvider = new PlaceholderEmbeddingProvider();
  }

  try {
    const raw = await currentProvider.embed(text);
    return normalizeToDimensions(raw, TARGET_DIMENSIONS);
  } catch (error) {
    console.warn(`Primary provider (${currentProvider.name}) failed:`, error);
    if (fallbackProvider) {
      console.log(`Falling back to ${fallbackProvider.name}...`);
      try {
        const raw = await fallbackProvider.embed(text);
        return normalizeToDimensions(raw, TARGET_DIMENSIONS);
      } catch (fallbackError) {
        console.warn(`Fallback (${fallbackProvider.name}) also failed:`, fallbackError);
        throw error;
      }
    }
    throw error;
  }
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (!currentProvider) {
    currentProvider = new PlaceholderEmbeddingProvider();
  }

  try {
    const raw = await currentProvider.embedBatch(texts);
    return raw.map(v => normalizeToDimensions(v, TARGET_DIMENSIONS));
  } catch (error) {
    console.warn(`Primary provider (${currentProvider.name}) failed batch:`, error);
    if (fallbackProvider) {
      console.log(`Falling back to ${fallbackProvider.name}...`);
      try {
        const raw = await fallbackProvider.embedBatch(texts);
        return raw.map(v => normalizeToDimensions(v, TARGET_DIMENSIONS));
      } catch (fallbackError) {
        console.warn(`Fallback (${fallbackProvider.name}) also failed:`, fallbackError);
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
