import type { EmbeddingProvider, EmbeddingConfig, ProviderName } from './provider.js';
import { OnnxEmbeddingProvider } from './onnx-provider.js';
import { GeminiEmbeddingProvider } from './gemini-provider.js';
import { PlaceholderEmbeddingProvider } from './placeholder-provider.js';

export type { EmbeddingProvider, EmbeddingConfig, ProviderName };
export { OnnxEmbeddingProvider, GeminiEmbeddingProvider, PlaceholderEmbeddingProvider };

export function createEmbeddingProvider(config: EmbeddingConfig): EmbeddingProvider {
  switch (config.provider) {
    case 'onnx':
      return new OnnxEmbeddingProvider(
        config.onnx?.modelId || 'Xenova/all-MiniLM-L6-v2',
        config.onnx?.cacheDir
      );
    case 'gemini':
      if (!config.gemini?.apiKey) {
        throw new Error('Gemini API key is required for gemini provider');
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
