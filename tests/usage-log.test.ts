import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevClient } from '../src/index.js';
import type { JevClientOptions, JevRequest, JevResult } from '../src/index.js';
import { batchRequest, batchResponse } from './fixtures.js';
import {
  configError,
  failureOf,
  jsonResponse,
  stallingFetch,
  stubFetch,
} from './support.js';

const KEY_MARKER = 'synthetic-key-marker';
const STATE_MARKER = 'private state marker 1f4d';
const PROVIDER_BODY_MARKER = 'raw provider body marker';
const RAW_EXCEPTION_MARKER = 'raw exception marker';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-usage-log-'));
  dirs.push(dir);
  return dir;
}

async function readLines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').filter(Boolean);
}

async function readRecords(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readLines(path)).map(
    (line) => JSON.parse(line) as Record<string, unknown>,
  );
}

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > 1000) {
      throw new Error('condition was not met');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('usage-log configuration', () => {
  it('rejects invalid usage-log options before evaluation', () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const invalid: unknown[] = [
      null,
      'usage.jsonl',
      {},
      { path: '' },
      { path: 'usage\u0000.jsonl' },
      { path: 7 },
      { path: 'usage.jsonl', caller: '' },
      { path: 'usage.jsonl', caller: 7 },
    ];
    for (const usageLog of invalid) {
      const error = configError({
        apiKey: KEY_MARKER,
        usageLog,
      } as unknown as JevClientOptions);
      expect(error.code).toBe('invalid_input');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('writes no usage file when logging is not configured', async () => {
    const dir = await tempDir();
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const client = createJevClient({ apiKey: KEY_MARKER });
    await client.evaluate(batchRequest);
    expect(existsSync(join(dir, 'usage.jsonl'))).toBe(false);
  });

  it('creates no file at construction and appends nothing before an evaluation', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const client = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path },
    });
    expect(existsSync(path)).toBe(false);
    await client.evaluate(batchRequest);
    expect(existsSync(path)).toBe(true);
    expect(await readLines(path)).toHaveLength(1);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe('usage records', () => {
  it('appends one documented success record and preserves existing contents', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    const existing = '{"existing":true}';
    await writeFile(path, `${existing}\n`);
    const existingMode = (await stat(path)).mode;
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const startedAt = Date.now();
    const client = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path, caller: 'review-agent' },
    });

    const result = await client.evaluate(batchRequest);

    expect(result).toEqual(batchResponse);
    const lines = await readLines(path);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(existing);
    const record = JSON.parse(lines[1] ?? '') as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual([
      'answers',
      'caller',
      'durationMs',
      'model',
      'questions',
      'timestamp',
      'usage',
    ]);
    expect(record.model).toBe(batchResponse.model);
    expect(record.questions).toEqual(batchRequest.questions);
    expect(record.answers).toEqual(batchResponse.answers);
    expect(record.usage).toEqual(batchResponse.usage);
    expect(record.caller).toBe('review-agent');
    const durationMs = record.durationMs as number;
    expect(typeof durationMs).toBe('number');
    expect(durationMs).toBeGreaterThanOrEqual(0);
    const timestamp = Date.parse(String(record.timestamp));
    expect(Number.isNaN(timestamp)).toBe(false);
    expect(String(record.timestamp).endsWith('Z')).toBe(true);
    expect(timestamp).toBeGreaterThanOrEqual(startedAt - 1000);
    expect(timestamp).toBeLessThanOrEqual(Date.now() + 1000);
    expect((await stat(path)).mode).toBe(existingMode);
    const content = await readFile(path, 'utf8');
    expect(content).not.toContain(KEY_MARKER);
    expect(content).not.toContain('Bearer');
  });

  it('records a provider failure with the configured model and no invented outcome fields', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    stubFetch(() =>
      Promise.resolve(
        jsonResponse({ detail: PROVIDER_BODY_MARKER, key: KEY_MARKER }, 429),
      ),
    );
    const client = createJevClient({
      apiKey: KEY_MARKER,
      model: 'jev-test-model',
      usageLog: { path },
    });

    const error = await failureOf(client.evaluate(batchRequest));

    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    const [record] = await readRecords(path);
    expect(record).toBeDefined();
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'durationMs',
      'errorCode',
      'model',
      'questions',
      'timestamp',
    ]);
    expect(record?.errorCode).toBe('rate_limited');
    expect(record?.model).toBe('jev-test-model');
    expect(record?.questions).toEqual(batchRequest.questions);
    expect(record?.answers).toBeUndefined();
    expect(record?.usage).toBeUndefined();
    const content = await readFile(path, 'utf8');
    expect(content).not.toContain(PROVIDER_BODY_MARKER);
    expect(content).not.toContain(KEY_MARKER);
  });

  it('records local invalid input without a provider call or raw serialization', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path },
    });
    const invalid = {
      state: STATE_MARKER,
      questions: {},
    } as unknown as JevRequest;

    const error = await failureOf(client.evaluate(invalid));

    expect(error.code).toBe('invalid_input');
    expect(fetchMock).not.toHaveBeenCalled();
    const [record] = await readRecords(path);
    expect(record?.errorCode).toBe('invalid_input');
    expect(record?.questions).toBeUndefined();
    expect(await readFile(path, 'utf8')).not.toContain(STATE_MARKER);
  });

  it('records pre-cancelled calls and timeouts with their safe codes', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const client = createJevClient({
      apiKey: KEY_MARKER,
      timeoutMs: 50,
      usageLog: { path },
    });
    const controller = new AbortController();
    controller.abort();

    const cancelled = await failureOf(
      client.evaluate(batchRequest, { signal: controller.signal }),
    );
    expect(cancelled.code).toBe('cancelled');

    stubFetch(stallingFetch());
    const timedOut = await failureOf(client.evaluate(batchRequest));
    expect(timedOut.code).toBe('timeout');

    const records = await readRecords(path);
    expect(records.map((record) => record.errorCode)).toEqual([
      'cancelled',
      'timeout',
    ]);
    for (const record of records) {
      expect(record.questions).toEqual(batchRequest.questions);
      expect(record.model).toBe('jev-1.13.0');
      expect(record.answers).toBeUndefined();
      expect(record.usage).toBeUndefined();
    }
  });

  it('excludes state, credentials, headers and raw failures while keeping allowed content', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    const request: JevRequest = {
      state: STATE_MARKER,
      questions: {
        relevance: {
          type: 'noul',
          instructions: 'Keep this submitted question text.',
        },
      },
    };
    const response: JevResult = {
      model: 'jev-1.13.0',
      answers: { relevance: { type: 'noul', noul: 0.4 } },
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const client = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path },
    });

    stubFetch(() => Promise.resolve(jsonResponse(response)));
    await client.evaluate(request);

    stubFetch(() =>
      Promise.resolve(jsonResponse({ detail: PROVIDER_BODY_MARKER }, 500)),
    );
    const providerFailure = await failureOf(client.evaluate(request));
    expect(providerFailure.code).toBe('unavailable');

    stubFetch(() => Promise.reject(new TypeError(RAW_EXCEPTION_MARKER)));
    const networkFailure = await failureOf(client.evaluate(request));
    expect(networkFailure.code).toBe('unavailable');

    const records = await readRecords(path);
    expect(records).toHaveLength(3);
    expect(records[0]?.answers).toEqual(response.answers);
    expect(records[1]?.errorCode).toBe('unavailable');
    expect(records[2]?.errorCode).toBe('unavailable');
    const content = await readFile(path, 'utf8');
    expect(content).toContain('Keep this submitted question text.');
    expect(content).not.toContain(STATE_MARKER);
    expect(content).not.toContain(KEY_MARKER);
    expect(content).not.toContain('Bearer');
    expect(content).not.toContain(PROVIDER_BODY_MARKER);
    expect(content).not.toContain(RAW_EXCEPTION_MARKER);
  });

  it('omits caller attribution unless the application supplies a label', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const client = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path },
    });

    await client.evaluate(batchRequest);

    const [record] = await readRecords(path);
    expect(Object.hasOwn(record ?? {}, 'caller')).toBe(false);
  });

  it('resolves a relative path against the working directory at construction', async () => {
    const dir = await tempDir();
    const previous = process.cwd();
    const client = (() => {
      try {
        process.chdir(dir);
        return createJevClient({
          apiKey: KEY_MARKER,
          usageLog: { path: 'relative.jsonl' },
        });
      } finally {
        process.chdir(previous);
      }
    })();
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));

    await client.evaluate(batchRequest);

    expect(existsSync(join(dir, 'relative.jsonl'))).toBe(true);
  });

  it('preserves arbitrary own question and answer keys', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    const request: JevRequest = {
      state: 'Synthetic note.',
      questions: {
        ['__proto__']: {
          type: 'choice',
          instructions: 'Pick one.',
          criteria: { ['__proto__']: 'Keep', ordinary: 'Revise' },
        },
      },
    };
    const response: JevResult = {
      model: 'jev-1.13.0',
      answers: {
        ['__proto__']: {
          type: 'choice',
          choice: '__proto__',
          probabilities: { ['__proto__']: 0.8, ordinary: 0.2 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 12, output_tokens: 6 },
    };
    stubFetch(() => Promise.resolve(jsonResponse(response)));
    const client = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path },
    });

    await client.evaluate(request);

    const [record] = await readRecords(path);
    const questions = record?.questions as Record<string, unknown>;
    expect(Object.hasOwn(questions, '__proto__')).toBe(true);
    expect(JSON.stringify(questions)).toBe(JSON.stringify(request.questions));
    const answers = record?.answers as Record<string, unknown>;
    expect(Object.hasOwn(answers, '__proto__')).toBe(true);
    expect(JSON.stringify(answers)).toBe(JSON.stringify(response.answers));
  });

  it('records the validated request snapshot rather than later caller mutation', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const client = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path },
    });
    const request = structuredClone(batchRequest);
    const expectedQuestions = structuredClone(batchRequest.questions);

    const evaluation = client.evaluate(request);
    const choice = request.questions.keep_or_revise as {
      type: 'choice';
      instructions: string;
    };
    choice.instructions = 'Mutated after submission.';
    request.state = 'Mutated state.';
    await evaluation;

    const [record] = await readRecords(path);
    expect(record?.questions).toEqual(expectedQuestions);
    expect(JSON.stringify(record)).not.toContain('Mutated');
  });

  it('writes separate parseable records for concurrent evaluations', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    const gates: Array<() => void> = [];
    stubFetch(
      () =>
        new Promise<Response>((resolveGate) => {
          gates.push(() => resolveGate(jsonResponse(batchResponse)));
        }),
    );
    const client = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path },
    });

    const first = client.evaluate(batchRequest);
    const second = client.evaluate(batchRequest);
    await waitFor(() => gates.length === 2);
    for (const gate of gates) {
      gate();
    }
    await Promise.all([first, second]);

    const lines = await readLines(path);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record.questions).toEqual(batchRequest.questions);
      expect(record.answers).toEqual(batchResponse.answers);
      expect(record.usage).toEqual(batchResponse.usage);
    }
  });

  it('contains write failures without diagnostics and allows later appends', async () => {
    const dir = await tempDir();
    const path = join(dir, 'missing', 'usage.jsonl');
    const stdout = vi.spyOn(process.stdout, 'write');
    const stderr = vi.spyOn(process.stderr, 'write');
    try {
      stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
      const client = createJevClient({
        apiKey: KEY_MARKER,
        usageLog: { path },
      });

      await expect(client.evaluate(batchRequest)).resolves.toEqual(
        batchResponse,
      );

      stubFetch(() => Promise.resolve(jsonResponse({}, 429)));
      const error = await failureOf(client.evaluate(batchRequest));
      expect(error.code).toBe('rate_limited');
      expect(error.status).toBe(429);

      expect(existsSync(path)).toBe(false);
      const diagnostics = [...stdout.mock.calls, ...stderr.mock.calls]
        .map((call) => String(call[0]))
        .join('');
      expect(diagnostics).not.toContain(path);
      expect(diagnostics).not.toContain(KEY_MARKER);

      await mkdir(join(dir, 'missing'));
      stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
      await expect(client.evaluate(batchRequest)).resolves.toEqual(
        batchResponse,
      );
      expect(await readLines(path)).toHaveLength(1);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});

describe('usage-log runtime shape', () => {
  it('keeps evaluation results identical with logging enabled', async () => {
    const dir = await tempDir();
    const path = join(dir, 'usage.jsonl');
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const logged = createJevClient({
      apiKey: KEY_MARKER,
      usageLog: { path },
    });
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const plain = createJevClient({ apiKey: KEY_MARKER });

    const withLog = await logged.evaluate(batchRequest);
    const withoutLog = await plain.evaluate(batchRequest);

    expect(withLog).toEqual(withoutLog);
  });
});
