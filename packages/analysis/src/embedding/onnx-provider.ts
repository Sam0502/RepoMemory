import { EmbeddingProvider } from './provider.js';
import { getLogger } from '@repo-memory/shared';

const logger = getLogger({ component: 'embeddings' });

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  private extractor: any = null;
  private initialized = false;
  readonly name = 'onnx';
  readonly dimensions = 384;

  constructor(private modelId: string = 'Xenova/all-MiniLM-L6-v2', private cacheDir?: string) {}

  async initialize(): Promise<void> {
    if (this.initialized) return;
    logger.info({ modelId: this.modelId }, 'Loading embedding model');
    try {
      // Lazy import so `@xenova/transformers` (onnxruntime native) loads only
      // when the ONNX provider is actually used — placeholder/gemini scans
      // never pay for it.
      const { pipeline, env } = await import('@xenova/transformers');
      if (this.cacheDir) {
        env.cacheDir = this.cacheDir;
      }
      env.allowRemoteModels = true;
      env.localModelPath = '';
      this.extractor = await pipeline('feature-extraction', this.modelId, {
        quantized: true,
      });
      this.initialized = true;
      logger.info({ modelId: this.modelId }, 'ONNX embedding model loaded successfully');
    } catch (error) {
      throw new Error(`Failed to load ONNX model: ${error}`);
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.initialized) await this.initialize();
    try {
      const result = await this.extractor(text, {
        pooling: 'mean',
        normalize: true,
      });
      return Array.from(result.data) as number[];
    } catch (error) {
      throw new Error(`ONNX embedding failed: ${error}`);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    if (!this.initialized) await this.initialize();
    try {
      const results = await this.extractor(texts, {
        pooling: 'mean',
        normalize: true,
      });
      return (Array.isArray(results) ? results : [results]).map((r: any) => Array.from(r.data) as number[]);
    } catch (error) {
      throw new Error(`ONNX embedding batch failed: ${error}`);
    }
  }
}
