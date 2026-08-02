import { describe, it, expect } from 'vitest';
import {
  inferDomain,
  inferArchitecturalRole,
  parseDomainConfig,
  applyDomainMetadata,
} from '../src/domain.js';
import { makeEntity } from './helpers.js';
import { EntityType } from '@repo-memory/shared';

describe('inferDomain', () => {
  it('infers web for controllers/routes/api paths', () => {
    expect(inferDomain('src/controllers/users.ts')).toBe('web');
    expect(inferDomain('src/routes/users.ts')).toBe('web');
    expect(inferDomain('src/api/users.ts')).toBe('web');
  });

  it('infers data for models/entities/schemas', () => {
    expect(inferDomain('src/models/user.ts')).toBe('data');
    expect(inferDomain('src/schemas/user.ts')).toBe('data');
  });

  it('infers business for services/usecases', () => {
    expect(inferDomain('src/services/auth.ts')).toBe('business');
    expect(inferDomain('src/domain/orders.ts')).toBe('business');
  });

  it('falls back to the top-level directory', () => {
    expect(inferDomain('src/weird/file.ts')).toBe('src');
  });

  it('falls back to core when there is no directory', () => {
    expect(inferDomain('file.ts')).toBe('core');
  });
});

describe('inferArchitecturalRole', () => {
  it('maps endpoint/test/config entity types directly', () => {
    expect(inferArchitecturalRole('src/any.ts', EntityType.API_ENDPOINT)).toBe('api');
    expect(inferArchitecturalRole('src/any.ts', EntityType.TEST)).toBe('test');
    expect(inferArchitecturalRole('src/any.ts', EntityType.CONFIG)).toBe('config');
  });

  it('maps directory patterns', () => {
    expect(inferArchitecturalRole('src/controllers/x.ts', EntityType.FUNCTION)).toBe('presentation');
    expect(inferArchitecturalRole('src/services/x.ts', EntityType.FUNCTION)).toBe('application');
    expect(inferArchitecturalRole('src/utils/x.ts', EntityType.FUNCTION)).toBe('shared utility');
    expect(inferArchitecturalRole('src/random/x.ts', EntityType.FUNCTION)).toBe('implementation');
  });
});

describe('parseDomainConfig', () => {
  it('parses a boundaries.json shape', () => {
    const config = parseDomainConfig(
      JSON.stringify({
        domains: [
          { name: 'web', paths: ['src/routes'] },
          { name: 'data', paths: ['src/models'], default: true },
        ],
        allowedCrossDomain: [{ from: 'web', to: 'data' }],
        strict: true,
      })
    );
    expect(config.domains).toHaveLength(2);
    expect(config.allowedCrossDomain).toEqual([{ from: 'web', to: 'data' }]);
    expect(config.strict).toBe(true);
  });

  it('defaults missing fields', () => {
    const config = parseDomainConfig('{}');
    expect(config.domains).toEqual([]);
    expect(config.allowedCrossDomain).toEqual([]);
    expect(config.strict).toBe(false);
  });
});

describe('applyDomainMetadata', () => {
  it('populates domain and architecturalRole only when absent', () => {
    const e1 = makeEntity({ name: 'a', stableId: 'a', filePath: 'src/controllers/x.ts' });
    const e2 = makeEntity({
      name: 'b',
      stableId: 'b',
      filePath: 'src/other.ts',
      domain: 'custom',
      architecturalRole: 'custom-role',
    });
    applyDomainMetadata([e1, e2]);
    expect(e1.domain).toBe('web');
    expect(e1.architecturalRole).toBe('presentation');
    expect(e2.domain).toBe('custom');
    expect(e2.architecturalRole).toBe('custom-role');
  });

  it('applies configured domains before heuristics', () => {
    const config = parseDomainConfig(
      JSON.stringify({
        domains: [{ name: 'payments', paths: ['src/routes'] }],
        allowedCrossDomain: [],
      })
    );
    const e = makeEntity({ name: 'a', stableId: 'a', filePath: 'src/routes/x.ts' });
    applyDomainMetadata([e], config);
    expect(e.domain).toBe('payments');
  });
});
