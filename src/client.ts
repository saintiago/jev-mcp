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

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_TIMEOUT_MS = 10000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface JevClientOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export interface JevEvaluateOptions {
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
}

type AbortSource = 'timeout' | 'cancelled';

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
  return { apiKey, model, timeoutMs };
}

async function evaluateRequest(
  config: JevClientConfig,
  request: JevRequest,
  options?: JevEvaluateOptions,
): Promise<JevResult> {
  const snapshot = snapshotRequest(request);
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
  const timer = setTimeout(() => abortWith('timeout'), config.timeoutMs);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  const abortError = (): JevError => {
    if (abortSource === 'timeout') {
      return new JevError('timeout');
    }
    if (abortSource === 'cancelled') {
      return new JevError('cancelled');
    }
    return new JevError('unavailable');
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
        signal: controller.signal,
      });
    } catch {
      throw abortError();
    }

    if (!response.ok) {
      await releaseBody(response);
      throw httpError(response.status);
    }

    let payload: string;
    try {
      payload = await response.text();
    } catch {
      throw abortError();
    }

    let body: unknown;
    try {
      body = JSON.parse(payload);
    } catch {
      throw new JevError('invalid_response');
    }

    const result = parseJsonValue(jevResultSchema, body);
    if (result === undefined) {
      throw new JevError('invalid_response');
    }
    assertAnswersMatch(result, snapshot);
    return result;
  } finally {
    clearTimeout(timer);
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

function assertAnswersMatch(result: JevResult, request: JevRequest): void {
  const questionIds = Object.keys(request.questions);
  if (Object.keys(result.answers).length !== questionIds.length) {
    throw new JevError('invalid_response');
  }
  for (const id of questionIds) {
    const question = request.questions[id];
    const answer = result.answers[id];
    if (
      question === undefined ||
      answer === undefined ||
      !answerMatches(question, answer)
    ) {
      throw new JevError('invalid_response');
    }
  }
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
