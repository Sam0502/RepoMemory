import { createHash } from 'crypto';
import { EmbeddingProvider } from './provider.js';

const EMBEDDING_DIMENSION = 768;

export class PlaceholderEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'placeholder';
  readonly dimensions = EMBEDDING_DIMENSION;

  async embed(text: string): Promise<number[]> {
    const hash = createHash('sha256').update(text).digest();
    const vector: number[] = [];

    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      const byteIndex = i % hash.length;
      const val = (hash[byteIndex] / 255) * 2 - 1;
      vector.push(val);
    }

    const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
    if (magnitude > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= magnitude;
      }
    }

    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: number[][] = [];
    for (const text of texts) {
      results.push(await this.embed(text));
    }
    return results;
  }
}
