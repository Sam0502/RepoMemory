import { describe, it, expect } from 'vitest';
import { QaService } from '../src/qa.js';

// Private methods are exercised via `as any`; all constructor deps are unused
// for the pure classification/splitting logic under test.
const service = new QaService(
  null as never,
  null as never,
  null as never,
  null as never,
  null as never
) as unknown as {
  classifyIntent(question: string): string;
  splitFragments(question: string): string[];
  stripQuestion(question: string): string;
};

describe('QaService.classifyIntent', () => {
  it('classifies dependency questions', () => {
    expect(service.classifyIntent('what does createUser depend on?')).toBe('dependencies');
    expect(service.classifyIntent('what imports are used by server?')).toBe('dependencies');
  });

  it('classifies dependent questions', () => {
    expect(service.classifyIntent('who calls createUser?')).toBe('dependents');
    expect(service.classifyIntent('who uses TraversalService?')).toBe('dependents');
  });

  it('classifies location questions', () => {
    expect(service.classifyIntent('where is createUser defined?')).toBe('location');
  });

  it('classifies ownership questions', () => {
    expect(service.classifyIntent('who owns src/api/users.ts?')).toBe('ownership');
    expect(service.classifyIntent('who wrote this file?')).toBe('ownership');
  });

  it('classifies dead-code questions', () => {
    expect(service.classifyIntent('is this dead code?')).toBe('deadcode');
    expect(service.classifyIntent('which symbols are unused?')).toBe('deadcode');
  });

  it('classifies impact questions', () => {
    expect(service.classifyIntent('what breaks if I change createUser?')).toBe('impact');
    expect(service.classifyIntent('what is impacted by this change?')).toBe('impact');
  });

  it('classifies churn and drift questions', () => {
    expect(service.classifyIntent('which files change the most?')).toBe('churn');
    expect(service.classifyIntent('is the architecture drifting?')).toBe('drift');
  });

  it('classifies changelog questions', () => {
    expect(service.classifyIntent('what changed recently in this file?')).toBe('changelog');
  });

  it('classifies path questions', () => {
    expect(service.classifyIntent('how does a.ts relate to b.ts?')).toBe('path');
    expect(service.classifyIntent('what is the path from a to b?')).toBe('path');
  });

  it('defaults to info', () => {
    expect(service.classifyIntent('describe the project')).toBe('info');
  });
});

describe('QaService.splitFragments', () => {
  it('splits on and/then/semicolons/periods', () => {
    expect(service.splitFragments('where is X defined and who calls it')).toEqual([
      'where is X defined',
      'who calls it',
    ]);
    expect(service.splitFragments('a; b. c then d')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops empty fragments', () => {
    expect(service.splitFragments('a and')).toEqual(['a']);
    expect(service.splitFragments('')).toEqual([]);
  });
});

describe('QaService.stripQuestion', () => {
  it('lowercases and strips stop words', () => {
    const result = service.stripQuestion('Where is createUser Function defined?');
    expect(result).not.toContain('where');
    expect(result).not.toContain('is');
  });

  it('limits to 3 significant tokens', () => {
    const result = service.stripQuestion('Where is the createUser helper module defined');
    expect(result.split(' ')).toHaveLength(3);
  });
});
