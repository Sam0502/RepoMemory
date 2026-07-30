import { pipeline, env } from '@xenova/transformers';
import { EmbeddingProvider } from './provider.js';

export class OnnxEmbeddingProvider implements EmbeddingProvider {
  private extractor: any = null;
  private initialized = false;
  readonly name = 'onnx';
  readonly dimensions = 384;

  constructor(private modelId: string = 'Xenova/all-MiniLM-L6-v2', cacheDir?: string) {
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
    env.allowRemoteModels = true;
    env.localModelPath = '';
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    console.log(`Loading embedding model: ${this.modelId}...`);
    try {
      this.extractor = await pipeline('feature-extraction', this.modelId, {
        quantized: true,
      });
      this.initialized = true;
      console.log('ONNX embedding model loaded successfully.');
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
    if (!this.initialized) await this.initialize();
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}
