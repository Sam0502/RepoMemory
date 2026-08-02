import { describe, it, expect } from 'vitest';
import { EntityType, RelationshipType, Language } from '@repo-memory/shared';

describe('shared type constants', () => {
  it('exposes the expected EntityType values', () => {
    expect(EntityType.FILE).toBe('File');
    expect(EntityType.CLASS).toBe('Class');
    expect(EntityType.FUNCTION).toBe('Function');
    expect(EntityType.API_ENDPOINT).toBe('ApiEndpoint');
    expect(EntityType.CONFIG).toBe('Config');
    expect(EntityType.MODEL).toBe('Model');
  });

  it('exposes the expected RelationshipType values', () => {
    expect(RelationshipType.IMPORTS).toBe('IMPORTS');
    expect(RelationshipType.CALLS).toBe('CALLS');
    expect(RelationshipType.HANDLES).toBe('HANDLES');
    expect(RelationshipType.CONTAINS).toBe('CONTAINS');
  });

  it('exposes the expected Language values', () => {
    expect(Language.TYPESCRIPT).toBe('typescript');
    expect(Language.PYTHON).toBe('python');
    expect(Language.UNKNOWN).toBe('unknown');
  });
});
