import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevClient, JevError } from '../src/index.js';
import type { JevErrorCode, JevRequest } from '../src/index.js';
import { batchRequest, batchResponse } from './fixtures.js';
import {
  failureOf,
  jsonResponse,
  stallingFetch,
  stubFetch,
} from './support.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('provider failures', () => {
  const statusCases: Array<[number, JevErrorCode]> = [
    [422, 'invalid_input'],
    [401, 'authentication'],
    [403, 'authentication'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ];

  for (const [status, code] of statusCases) {
    it(`maps HTTP ${status} to ${code}, retains the status and releases the body`, async () => {
      const response = jsonResponse(
        { error: 'synthetic provider detail' },
        status,
      );
      const fetchMock = stubFetch(() => Promise.resolve(response));
      const client = createJevClient({ apiKey: 'synthetic-key' });

      const error = await failureOf(client.evaluate(batchRequest));

      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.bodyUsed).toBe(true);
    });
  }

  it('maps a network failure to unavailable without a status', async () => {
    const fetchMock = stubFetch(() =>
      Promise.reject(new TypeError('fetch failed')),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(client.evaluate(batchRequest));

    expect(error.code).toBe('unavailable');
    expect(error.status).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a failed body read to unavailable without a status', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: null,
        text: () => Promise.reject(new TypeError('terminated')),
      } as unknown as Response),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(client.evaluate(batchRequest));

    expect(error.code).toBe('unavailable');
    expect(error.status).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('bounded calls', () => {
  it('rejects with timeout when the deadline passes during body reading', async () => {
    const fetchMock = stubFetch(stallingFetch());
    const client = createJevClient({
      apiKey: 'synthetic-key',
      timeoutMs: 20,
    });

    const error = await failureOf(client.evaluate(batchRequest));

    expect(error.code).toBe('timeout');
    expect(error.status).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects with cancelled when the caller cancels before the deadline', async () => {
    const controller = new AbortController();
    const fetchMock = stubFetch(stallingFetch());
    const client = createJevClient({
      apiKey: 'synthetic-key',
      timeoutMs: 5000,
    });

    const evaluation = failureOf(
      client.evaluate(batchRequest, { signal: controller.signal }),
    );
    await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    const error = await evaluation;

    expect(error.code).toBe('cancelled');
    expect(error.status).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects an already cancelled call without a provider request', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(
      client.evaluate(batchRequest, { signal: controller.signal }),
    );

    expect(error.code).toBe('cancelled');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses a 10000 ms default timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(stallingFetch());
    const client = createJevClient({ apiKey: 'synthetic-key' });
    let settled = false;
    const evaluation = client.evaluate(batchRequest);
    const outcome = evaluation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(9999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await outcome;

    expect(settled).toBe(true);
    const error = await failureOf(evaluation);
    expect(error).toBeInstanceOf(JevError);
    expect(error.code).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('cleanup', () => {
  it('removes the caller abort listener after evaluation', async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, 'addEventListener');
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');
    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    const client = createJevClient({ apiKey: 'synthetic-key' });

    await client.evaluate(batchRequest, { signal: controller.signal });

    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0]?.[1]).toBe(addSpy.mock.calls[0]?.[1]);
  });

  it('clears the deadline timer on success and failure', async () => {
    vi.useFakeTimers();
    const client = createJevClient({ apiKey: 'synthetic-key' });

    stubFetch(() => Promise.resolve(jsonResponse(batchResponse)));
    await client.evaluate(batchRequest);
    expect(vi.getTimerCount()).toBe(0);

    stubFetch(() => Promise.resolve(jsonResponse({}, 429)));
    await failureOf(client.evaluate(batchRequest));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('safe failures', () => {
  const secretKey = 'sk-synthetic-secret-9d3f';
  const secretState = 'Synthetic secret evidence 4b1c';
  const secretQuestion = 'Synthetic secret question 7a2e';
  const request = {
    state: secretState,
    questions: {
      relevant: { type: 'noul', instructions: secretQuestion },
    },
  } as JevRequest;

  it('keeps credentials, evidence and provider bodies out of HTTP failures', async () => {
    const response = jsonResponse(
      {
        error: {
          api_key: secretKey,
          state: secretState,
          question: secretQuestion,
        },
      },
      429,
    );
    const fetchMock = stubFetch(() => Promise.resolve(response));
    const client = createJevClient({ apiKey: secretKey });

    const error = await failureOf(client.evaluate(request));

    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.message).not.toContain(secretKey);
    expect(error.message).not.toContain(secretState);
    expect(error.message).not.toContain(secretQuestion);
    expect(JSON.stringify(error)).not.toContain(secretKey);
    expect(JSON.stringify(error)).not.toContain(secretState);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the raw body out of invalid response failures', async () => {
    const rawBody = `{"api_key":"${secretKey}","state":"${secretState}"`;
    const fetchMock = stubFetch(() =>
      Promise.resolve(new Response(rawBody, { status: 200 })),
    );
    const client = createJevClient({ apiKey: secretKey });

    const error = await failureOf(client.evaluate(request));

    expect(error.code).toBe('invalid_response');
    expect(error.message).not.toContain(secretKey);
    expect(error.message).not.toContain(secretState);
    expect(JSON.stringify(error)).not.toContain(secretKey);
    expect(JSON.stringify(error)).not.toContain(secretState);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps evidence out of local validation failures', async () => {
    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const client = createJevClient({ apiKey: secretKey });
    const invalidRequest = {
      state: secretState,
      questions: { broken: { type: 'noul' } },
    } as unknown as JevRequest;

    const error = await failureOf(client.evaluate(invalidRequest));

    expect(error.code).toBe('invalid_input');
    expect(error.message).not.toContain(secretState);
    expect(JSON.stringify(error)).not.toContain(secretState);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
