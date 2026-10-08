import { EmbeddingProvider } from './provider.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODEL = 'text-embedding-004';

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly dimensions = 768;
  private apiKey: string;
  private model: string;

  constructor(config: { apiKey: string; model?: string }) {
    this.apiKey = config.apiKey;
    this.model = config.model || DEFAULT_MODEL;
  }

  async embed(text: string): Promise<number[]> {
    const url = `${GEMINI_BASE}/${this.model}:embedContent`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          model: `models/${this.model}`,
          content: { parts: [{ text: text.slice(0, 8000) }] },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini API error: ${response.status} ${err}`);
      }

      const data = await response.json() as any;
      const values = data.embedding?.values as unknown;
      if (!Array.isArray(values) || values.length === 0 || values.some(v => typeof v !== 'number')) {
        throw new Error('Gemini API returned a malformed embedding');
      }
      return values as number[];
    } finally {
      clearTimeout(timeout);
    }
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const url = `${GEMINI_BASE}/${this.model}:batchEmbedContents`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify({
          requests: texts.map(text => ({
            model: `models/${this.model}`,
            content: { parts: [{ text: text.slice(0, 8000) }] },
          })),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const results: number[][] = [];
        for (const text of texts) {
          results.push(await this.embed(text));
        }
        return results;
      }

      const data = await response.json() as any;
      const embeddings = data.embeddings as unknown;
      if (!Array.isArray(embeddings) || embeddings.length !== texts.length) {
        // Fall back per-item rather than storing partial/zero vectors.
        const results: number[][] = [];
        for (const text of texts) {
          results.push(await this.embed(text));
        }
        return results;
      }
      return (embeddings as any[]).map((e: any) => {
        if (!Array.isArray(e?.values) || e.values.length === 0) {
          throw new Error('Gemini API returned a malformed batch embedding');
        }
        return e.values as number[];
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
