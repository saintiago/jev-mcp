import { appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { JevAnswer, JevQuestion, JevUsage } from './contracts.js';
import type { JevErrorCode } from './errors.js';

export interface JevUsageLogOptions {
  path: string;
  caller?: string;
}

export interface JevUsageRecord {
  timestamp: string;
  durationMs: number;
  model: string;
  questions?: Record<string, JevQuestion>;
  answers?: Record<string, JevAnswer>;
  usage?: JevUsage;
  errorCode?: JevErrorCode;
  caller?: string;
}

export interface JevUsageLog {
  readonly caller: string | undefined;
  append(record: JevUsageRecord): Promise<void>;
}

export function createUsageLog(options: JevUsageLogOptions): JevUsageLog {
  const path = resolve(options.path);
  let tail: Promise<void> = Promise.resolve();
  const append = (record: JevUsageRecord): Promise<void> => {
    const line = `${JSON.stringify(record)}\n`;
    const attempt = tail.then(() =>
      appendFile(path, line, { encoding: 'utf8', mode: 0o600 }),
    );
    tail = attempt.then(
      () => undefined,
      () => undefined,
    );
    return tail;
  };
  return { caller: options.caller, append };
}
