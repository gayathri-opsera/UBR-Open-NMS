/**
 * V2 Structured Error Logging Service (WO-019)
 * Provides consistent structured logs with actor, context, and severity.
 * In production this could ship to an observability backend.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  level: LogLevel;
  message: string;
  context?: string;
  actor?: string;
  error?: unknown;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

function emit(entry: LogEntry): void {
  const { level, message, context, actor, error, metadata } = entry;
  const prefix = context ? `[${context}]` : '';
  const actorStr = actor ? ` (actor:${actor})` : '';
  const payload = { ...metadata, ...(error ? { error } : {}) };

  /* eslint-disable no-console */
  switch (level) {
    case 'debug': console.debug(`${prefix}${actorStr} ${message}`, payload); break;
    case 'info':  console.info(`${prefix}${actorStr} ${message}`, payload); break;
    case 'warn':  console.warn(`${prefix}${actorStr} ${message}`, payload); break;
    case 'error': console.error(`${prefix}${actorStr} ${message}`, payload); break;
  }
  /* eslint-enable no-console */
}

export const logger = {
  debug: (message: string, opts?: Partial<Omit<LogEntry, 'level' | 'message' | 'timestamp'>>) =>
    emit({ level: 'debug', message, timestamp: new Date().toISOString(), ...opts }),

  info: (message: string, opts?: Partial<Omit<LogEntry, 'level' | 'message' | 'timestamp'>>) =>
    emit({ level: 'info', message, timestamp: new Date().toISOString(), ...opts }),

  warn: (message: string, opts?: Partial<Omit<LogEntry, 'level' | 'message' | 'timestamp'>>) =>
    emit({ level: 'warn', message, timestamp: new Date().toISOString(), ...opts }),

  error: (message: string, error?: unknown, opts?: Partial<Omit<LogEntry, 'level' | 'message' | 'timestamp' | 'error'>>) =>
    emit({ level: 'error', message, error, timestamp: new Date().toISOString(), ...opts }),
};
