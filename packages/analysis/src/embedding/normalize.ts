export const TARGET_DIMENSIONS = 768;

export function normalizeToDimensions(vector: number[], targetDim: number = TARGET_DIMENSIONS): number[] {
  if (vector.length === targetDim) return vector;

  if (vector.length > targetDim) {
    return vector.slice(0, targetDim);
  }

  const padded = [...vector, ...new Array(targetDim - vector.length).fill(0)];
  const magnitude = Math.sqrt(padded.reduce((sum, v) => sum + v * v, 0));
  if (magnitude > 0) {
    for (let i = 0; i < padded.length; i++) {
      padded[i] /= magnitude;
    }
  }
  return padded;
}

export function l2Normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map(v => v / magnitude);
}
