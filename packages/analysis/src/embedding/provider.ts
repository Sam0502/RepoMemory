export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly dimensions: number;
  readonly name: string;
}

export type ProviderName = 'onnx' | 'gemini' | 'placeholder';

export interface EmbeddingConfig {
  provider: ProviderName;
  onnx?: {
    modelId: string;
    cacheDir: string;
  };
  gemini?: {
    apiKey: string;
    model?: string;
  };
}
