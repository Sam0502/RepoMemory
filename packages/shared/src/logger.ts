export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

export type LoggerBindings = Record<string, unknown>;

export interface LoggerOptions {
  level?: LogLevel;
  base?: Record<string, unknown>;
  stream?: NodeJS.WritableStream;
}

// Numeric severities mirror pino so existing log parsers keep working.
const LEVEL_SEVERITY: Record<LogLevel, number> = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
};

const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'];

function resolveLevel(level?: LogLevel): LogLevel {
  if (level) return level;
  const envLevel = (process.env.PINO_LOG_LEVEL || 'info').toLowerCase();
  return (LOG_LEVELS.includes(envLevel as LogLevel) ? envLevel : 'info') as LogLevel;
}

function serializeError(err: Error): Record<string, unknown> {
  return {
    type: err.name || 'Error',
    message: err.message,
    stack: err.stack,
  };
}

/**
 * Minimal structured logger (no dependencies). Emits pino-compatible JSON
 * lines to stderr so CLI command results written to stdout stay
 * machine-readable. The default level comes from the PINO_LOG_LEVEL
 * environment variable (default: info).
 *
 * Usage:
 *   logger.info('Plain message');
 *   logger.info({ repoPath, entityCount }, 'Message with context');
 *   logger.error(err, 'Message with an error');
 */
export class Logger {
  private readonly level: LogLevel;
  private readonly stream: NodeJS.WritableStream;
  private readonly base: Record<string, unknown>;

  private constructor(level: LogLevel, stream: NodeJS.WritableStream, base: Record<string, unknown>) {
    this.level = level;
    this.stream = stream;
    this.base = base;
  }

  static create(opts: LoggerOptions = {}): Logger {
    return new Logger(resolveLevel(opts.level), opts.stream ?? process.stderr, { ...(opts.base ?? {}) });
  }

  child(bindings: LoggerBindings): Logger {
    return new Logger(this.level, this.stream, { ...this.base, ...bindings });
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
    if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[this.level]) return;
    const line: Record<string, unknown> = {
      level: LEVEL_SEVERITY[level],
      time: Date.now(),
      pid: process.pid,
      ...this.base,
    };
    if (typeof a === 'string') {
      line.msg = a;
    } else if (a instanceof Error) {
      line.err = serializeError(a);
      line.msg = b ?? '';
    } else {
      Object.assign(line, a);
      line.msg = b ?? '';
    }
    this.stream.write(JSON.stringify(line) + '\n');
  }
}

let rootLogger: Logger | null = null;

export function getLogger(bindings?: LoggerBindings): Logger {
  if (!rootLogger) {
    rootLogger = Logger.create();
  }
  return bindings ? rootLogger.child(bindings) : rootLogger;
}
