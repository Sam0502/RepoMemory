import { pino } from 'pino';
import type { Level as PinoLevel, Logger as PinoLogger } from 'pino';

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type LoggerBindings = Record<string, unknown>;

export interface LoggerOptions {
  level?: LogLevel;
  base?: Record<string, unknown>;
  stream?: NodeJS.WritableStream;
}

const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

function resolveLevel(level?: LogLevel): LogLevel {
  if (level) return level;
  const envLevel = (process.env.PINO_LOG_LEVEL || 'info').toLowerCase();
  return (LOG_LEVELS.includes(envLevel as LogLevel) ? envLevel : 'info') as LogLevel;
}

function toPinoLevel(level: LogLevel): PinoLevel {
  return level;
}

/**
 * Thin wrapper around pino. Logs go to stderr (JSON lines) so CLI command
 * results written to stdout stay machine-readable. The default level comes
 * from the PINO_LOG_LEVEL environment variable (default: info).
 *
 * Usage:
 *   logger.info('Plain message');
 *   logger.info({ repoPath, entityCount }, 'Message with context');
 *   logger.error(err, 'Message with an error');
 */
export class Logger {
  private inner: PinoLogger;

  private constructor(inner: PinoLogger) {
    this.inner = inner;
  }

  static create(opts: LoggerOptions = {}): Logger {
    const level = toPinoLevel(resolveLevel(opts.level));
    const inner = pino({ level }, opts.stream ?? process.stderr);
    return new Logger(opts.base ? inner.child(opts.base) : inner);
  }

  child(bindings: LoggerBindings): Logger {
    return new Logger(this.inner.child(bindings));
  }

  fatal(msg: string): void;
  fatal(bindings: LoggerBindings, msg: string): void;
  fatal(err: Error, msg: string): void;
  fatal(a: string | LoggerBindings | Error, b?: string): void {
    this.write('fatal', a, b);
  }

  error(msg: string): void;
  error(bindings: LoggerBindings, msg: string): void;
  error(err: Error, msg: string): void;
  error(a: string | LoggerBindings | Error, b?: string): void {
    this.write('error', a, b);
  }

  warn(msg: string): void;
  warn(bindings: LoggerBindings, msg: string): void;
  warn(err: Error, msg: string): void;
  warn(a: string | LoggerBindings | Error, b?: string): void {
    this.write('warn', a, b);
  }

  info(msg: string): void;
  info(bindings: LoggerBindings, msg: string): void;
  info(err: Error, msg: string): void;
  info(a: string | LoggerBindings | Error, b?: string): void {
    this.write('info', a, b);
  }

  debug(msg: string): void;
  debug(bindings: LoggerBindings, msg: string): void;
  debug(err: Error, msg: string): void;
  debug(a: string | LoggerBindings | Error, b?: string): void {
    this.write('debug', a, b);
  }

  trace(msg: string): void;
  trace(bindings: LoggerBindings, msg: string): void;
  trace(err: Error, msg: string): void;
  trace(a: string | LoggerBindings | Error, b?: string): void {
    this.write('trace', a, b);
  }

  private write(level: LogLevel, a: string | LoggerBindings | Error, b?: string): void {
    const fn = this.inner[toPinoLevel(level)].bind(this.inner) as (x: unknown, y?: unknown) => void;
    if (typeof a === 'string') {
      fn(a);
    } else {
      fn(a, b ?? '');
    }
  }
}

let rootLogger: Logger | null = null;

export function getLogger(bindings?: LoggerBindings): Logger {
  if (!rootLogger) {
    rootLogger = Logger.create();
  }
  return bindings ? rootLogger.child(bindings) : rootLogger;
}
