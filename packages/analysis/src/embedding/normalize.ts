export const TARGET_DIMENSIONS = 768;

// Normalize any provider vector to TARGET_DIMENSIONS with L2 unit length.
// NOTE: outputs are only comparable within a single provider. Switching
// providers requires a re-embed (see embeddings.ts recordEmbeddingProvider),
// otherwise zero-padded 384d vectors and native 768d vectors share an index
// but live in different subspaces.
export function normalizeToDimensions(vector: number[], targetDim: number = TARGET_DIMENSIONS): number[] {
  if (!Array.isArray(vector) || vector.some(v => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('Refusing to normalize a malformed embedding vector');
  }
  let out: number[];
  if (vector.length === targetDim) {
    out = [...vector];
  } else if (vector.length > targetDim) {
    out = vector.slice(0, targetDim);
  } else {
    out = [...vector, ...new Array(targetDim - vector.length).fill(0)];
  }
  return l2Normalize(out);
}

function l2Normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map(v => v / magnitude);
}
