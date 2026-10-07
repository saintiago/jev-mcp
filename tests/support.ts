import { vi } from 'vitest';
import { createJevClient, JevError } from '../src/index.js';
import type { JevClientOptions } from '../src/index.js';

export type FetchHandler = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function stubFetch(handler: FetchHandler) {
  const fetchMock = vi.fn<FetchHandler>(handler);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

export type FetchMock = ReturnType<typeof stubFetch>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface SentRequest {
  url: string;
  init: RequestInit | undefined;
  body: {
    state: unknown;
    model: string;
    questions: Record<string, unknown>;
  };
}

export function sentRequest(fetchMock: FetchMock): SentRequest {
  const call = fetchMock.mock.calls[0];
  if (call === undefined) {
    throw new Error('fetch was not called');
  }
  const [url, init] = call;
  return {
    url: String(url),
    init,
    body: JSON.parse(String(init?.body)) as SentRequest['body'],
  };
}

export function stallingFetch(): FetchHandler {
  return (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      signal?.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      });
    });
}

export async function failureOf(promise: Promise<unknown>): Promise<JevError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JevError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the evaluation to fail');
}

export function configError(options: JevClientOptions): JevError {
  try {
    createJevClient(options);
  } catch (error) {
    if (error instanceof JevError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected client construction to fail');
}
