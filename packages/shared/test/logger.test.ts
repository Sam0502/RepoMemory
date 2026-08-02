import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { Logger } from '@repo-memory/shared';
import type { LogLevel } from '@repo-memory/shared';

async function captureLogs(level: LogLevel, fn: (log: Logger) => void): Promise<string> {
  const stream = new PassThrough();
  const log = Logger.create({ level, stream });
  const chunks: Buffer[] = [];
  stream.on('data', (c: Buffer) => chunks.push(c));
  fn(log);
  await new Promise((resolve) => setTimeout(resolve, 20));
  return chunks.map((c) => c.toString()).join('');
}

describe('Logger', () => {
  it('emits structured JSON lines with level, msg, and bindings', async () => {
    const out = await captureLogs('debug', (log) => log.info({ foo: 'bar' }, 'hello world'));
    expect(out).toContain('"level":30');
    expect(out).toContain('"msg":"hello world"');
    expect(out).toContain('"foo":"bar"');
  });

  it('supports plain string messages', async () => {
    const out = await captureLogs('debug', (log) => log.info('just a string'));
    expect(out).toContain('"msg":"just a string"');
  });

  it('serializes Error objects under the err field', async () => {
    const out = await captureLogs('debug', (log) => log.error(new Error('boom'), 'operation failed'));
    expect(out).toContain('"msg":"operation failed"');
    expect(out).toContain('"err"');
    expect(out).toContain('boom');
  });

  it('propagates child bindings to the emitted log line', async () => {
    const out = await captureLogs('debug', (log) =>
      log.child({ component: 'test', repoPath: '/repo' }).info('child message')
    );
    expect(out).toContain('"component":"test"');
    expect(out).toContain('"repoPath":"/repo"');
    expect(out).toContain('"msg":"child message"');
  });

  it('filters logs below the configured level', async () => {
    const out = await captureLogs('info', (log) => {
      log.debug('hidden line');
      log.info('visible line');
    });
    expect(out).not.toContain('hidden line');
    expect(out).toContain('visible line');
  });

  it('honors the PINO_LOG_LEVEL env var as the default level', async () => {
    const previous = process.env.PINO_LOG_LEVEL;
    process.env.PINO_LOG_LEVEL = 'warn';
    try {
      const stream = new PassThrough();
      const log = Logger.create({ stream });
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      log.info('hidden by warn');
      log.warn('shown at warn');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const out = chunks.map((c) => c.toString()).join('');
      expect(out).not.toContain('hidden by warn');
      expect(out).toContain('shown at warn');
    } finally {
      if (previous === undefined) {
        delete process.env.PINO_LOG_LEVEL;
      } else {
        process.env.PINO_LOG_LEVEL = previous;
      }
    }
  });
});
