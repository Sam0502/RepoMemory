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
    const url = `${GEMINI_BASE}/${this.model}:embedContent?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `models/${this.model}`,
        content: { parts: [{ text }] },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Gemini API error: ${response.status} ${err}`);
    }

    const data = await response.json() as any;
    return data.embedding?.values as number[] || [];
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const url = `${GEMINI_BASE}/${this.model}:batchEmbedContents?key=${this.apiKey}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map(text => ({
          model: `models/${this.model}`,
          content: { parts: [{ text }] },
        })),
      }),
    });

    if (!response.ok) {
      const results: number[][] = [];
      for (const text of texts) {
        results.push(await this.embed(text));
      }
      return results;
    }

    const data = await response.json() as any;
    return (data.embeddings || []).map((e: any) => e.values as number[]);
  }
}
