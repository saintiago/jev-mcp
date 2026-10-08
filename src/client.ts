import {
  FLOAT_TOLERANCE,
  jevRequestSchema,
  jevResultSchema,
  parseJsonValue,
} from './contracts.js';
import type {
  JevAnswer,
  JevQuestion,
  JevRequest,
  JevResult,
} from './contracts.js';
import { JevError } from './errors.js';
import { createUsageLog } from './usage-log.js';
import type {
  JevUsageLog,
  JevUsageLogOptions,
  JevUsageRecord,
} from './usage-log.js';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  usageLog?: JevUsageLogOptions;
}

export interface JevEvaluateOptions {
  /** Omit question text from usage logs when false. Defaults to true. */
  logQuestions?: boolean;
  signal?: AbortSignal;
}

export interface JevClient {
  evaluate(
    request: JevRequest,
    options?: JevEvaluateOptions,
  ): Promise<JevResult>;
}

interface JevClientConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  usageLog: JevUsageLog | undefined;
}

type AbortSource = 'timeout' | 'cancelled';

function scheduleDeadline(delayMs: number, onDeadline: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const scheduleChunk = (remainingMs: number): void => {
    timer = setTimeout(
      () => {
        const rest = remainingMs - MAX_TIMER_DELAY_MS;
        if (rest > 0) {
          scheduleChunk(rest);
        } else {
          onDeadline();
        }
      },
      Math.min(remainingMs, MAX_TIMER_DELAY_MS),
    );
  };
  scheduleChunk(delayMs);
  return () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}

export function createJevClient(options: JevClientOptions): JevClient {
  const config = parseOptions(options);
  return {
    evaluate: (request, evaluateOptions) =>
      evaluateRequest(config, request, evaluateOptions),
  };
}

function parseOptions(options: JevClientOptions): JevClientConfig {
  if (typeof options !== 'object' || options === null) {
    throw new JevError('invalid_input');
  }
  const apiKey = options.apiKey;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    CONTROL_CHARACTERS.test(apiKey)
  ) {
    throw new JevError('invalid_input');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new JevError('invalid_input');
  }
  if (
    typeof timeoutMs !== 'number' ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new JevError('invalid_input');
  }
  return {
    apiKey,
    model,
    timeoutMs,
    usageLog: parseUsageLog(options.usageLog),
  };
}

function parseUsageLog(
  usageLog: JevUsageLogOptions | undefined,
): JevUsageLog | undefined {
  if (usageLog === undefined) {
    return undefined;
  }
  if (typeof usageLog !== 'object' || usageLog === null) {
    throw new JevError('invalid_input');
  }
  const { path, caller } = usageLog;
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.includes('\u0000')
  ) {
    throw new JevError('invalid_input');
  }
  if (
    caller !== undefined &&
    (typeof caller !== 'string' || caller.length === 0)
  ) {
    throw new JevError('invalid_input');
  }
  return createUsageLog({ path, ...(caller !== undefined && { caller }) });
}

async function evaluateRequest(
  config: JevClientConfig,
  request: JevRequest,
  options?: JevEvaluateOptions,
): Promise<JevResult> {
  const usageLog = config.usageLog;
  if (usageLog === undefined) {
    return await runEvaluation(config, snapshotRequest(request), options);
  }
  const startedAt = new Date();
  const startTime = performance.now();
  let snapshot: JevRequest | undefined;
  try {
    snapshot = snapshotRequest(request);
    const result = await runEvaluation(config, snapshot, options);
    await appendUsage(usageLog, {
      timestamp: startedAt.toISOString(),
      durationMs: elapsedMs(startTime),
      model: result.model,
      ...(options?.logQuestions !== false && { questions: snapshot.questions }),
      answers: result.answers,
      usage: result.usage,
      ...(usageLog.caller !== undefined && { caller: usageLog.caller }),
    });
    return result;
  } catch (error) {
    await appendUsage(usageLog, {
      timestamp: startedAt.toISOString(),
      durationMs: elapsedMs(startTime),
      model: config.model,
      ...(snapshot !== undefined &&
        options?.logQuestions !== false && { questions: snapshot.questions }),
      errorCode: error instanceof JevError ? error.code : 'unavailable',
      ...(usageLog.caller !== undefined && { caller: usageLog.caller }),
    });
    throw error;
  }
}

async function appendUsage(
  usageLog: JevUsageLog,
  record: JevUsageRecord,
): Promise<void> {
  try {
    await usageLog.append(record);
  } catch {}
}

function elapsedMs(startTime: number): number {
  return Math.max(0, Math.round(performance.now() - startTime));
}

async function runEvaluation(
  config: JevClientConfig,
  snapshot: JevRequest,
  options?: JevEvaluateOptions,
): Promise<JevResult> {
  const callerSignal = options?.signal;
  if (callerSignal?.aborted === true) {
    throw new JevError('cancelled');
  }

  const controller = new AbortController();
  let abortSource: AbortSource | undefined;
  const abortWith = (source: AbortSource): void => {
    if (abortSource !== undefined) {
      return;
    }
    abortSource = source;
    controller.abort();
  };
  const onCallerAbort = (): void => abortWith('cancelled');
  const cancelDeadline = scheduleDeadline(config.timeoutMs, () =>
    abortWith('timeout'),
  );
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  const callFailure = (status: number | undefined): JevError => {
    if (abortSource === 'timeout') {
      return new JevError('timeout', status);
    }
    if (abortSource === 'cancelled') {
      return new JevError('cancelled', status);
    }
    return new JevError('unavailable', status);
  };

  try {
    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          state: snapshot.state,
          model: config.model,
          questions: snapshot.questions,
        }),
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      throw callFailure(undefined);
    }

    if (!response.ok) {
      await releaseBody(response);
      throw httpError(response.status);
    }

    let payload: string;
    try {
      payload = await response.text();
    } catch {
      throw callFailure(response.status);
    }

    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      throw new JevError('invalid_response', response.status);
    }

    const result = parseJsonValue(jevResultSchema, body);
    if (result === undefined || !answersMatch(result, snapshot)) {
      throw new JevError('invalid_response', response.status);
    }
    return result;
  } finally {
    cancelDeadline();
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

async function releaseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {}
}

function httpError(status: number): JevError {
  if (status === 422) {
    return new JevError('invalid_input', status);
  }
  if (status === 401 || status === 403) {
    return new JevError('authentication', status);
  }
  if (status === 429) {
    return new JevError('rate_limited', status);
  }
  return new JevError('unavailable', status);
}

function snapshotRequest(request: JevRequest): JevRequest {
  let compatible: boolean;
  try {
    compatible = isJsonCompatible(request, new Set());
  } catch {
    compatible = false;
  }
  if (!compatible) {
    throw new JevError('invalid_input');
  }
  const snapshot = parseJsonValue(jevRequestSchema, request);
  if (snapshot === undefined) {
    throw new JevError('invalid_input');
  }
  return snapshot;
}

function isJsonCompatible(value: unknown, ancestors: Set<object>): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  const isArray = Array.isArray(value);
  const supportedPrototype = isArray
    ? prototype === Array.prototype || prototype === null
    : prototype === Object.prototype || prototype === null;
  if (!supportedPrototype || Object.getOwnPropertySymbols(value).length > 0) {
    return false;
  }
  const keys = Object.keys(value);
  if (isArray && keys.length !== value.length) {
    return false;
  }
  ancestors.add(value);
  for (const key of keys) {
    if (!isJsonCompatible((value as Record<string, unknown>)[key], ancestors)) {
      ancestors.delete(value);
      return false;
    }
  }
  ancestors.delete(value);
  return true;
}

function answersMatch(result: JevResult, request: JevRequest): boolean {
  const questionIds = Object.keys(request.questions);
  if (Object.keys(result.answers).length !== questionIds.length) {
    return false;
  }
  for (const id of questionIds) {
    const question = request.questions[id];
    const answer = result.answers[id];
    if (
      question === undefined ||
      answer === undefined ||
      !answerMatches(question, answer)
    ) {
      return false;
    }
  }
  return true;
}

function answerMatches(question: JevQuestion, answer: JevAnswer): boolean {
  if (question.type !== answer.type) {
    return false;
  }
  switch (question.type) {
    case 'noul':
      return true;
    case 'choice':
      return (
        answer.type === 'choice' &&
        Object.hasOwn(question.criteria, answer.choice) &&
        sameKeys(Object.keys(question.criteria), answer.probabilities)
      );
    case 'score': {
      if (answer.type !== 'score') {
        return false;
      }
      const levels: string[] = [];
      for (let index = 0; index < question.criteria.length; index += 1) {
        levels.push(String(index));
      }
      return (
        sameKeys(levels, answer.legend) &&
        sameKeys(levels, answer.probabilities) &&
        answer.score >= 0 &&
        answer.score <= question.criteria.length - 1 + FLOAT_TOLERANCE
      );
    }
  }
}

function sameKeys(
  expected: readonly string[],
  record: Readonly<Record<string, unknown>>,
): boolean {
  const keys = Object.keys(record);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(record, key))
  );
}
