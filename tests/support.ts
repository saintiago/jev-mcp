import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';
import { createJevClient, JevError } from '../src/index.js';
import type { JevClientOptions } from '../src/index.js';

export const FIXED_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

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

export interface LoopbackServer {
  server: Server;
  origin: string;
}

export async function startLoopbackServer(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<LoopbackServer> {
  const server = createServer(respond);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

export async function stopLoopbackServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export function stubNativeFetch(origin: string): {
  fetchMock: FetchMock;
  destinations: string[];
} {
  const nativeFetch = globalThis.fetch;
  const destinations: string[] = [];
  const fetchMock = vi.fn<FetchHandler>((input, init) => {
    const destination = String(input);
    if (destination !== FIXED_ENDPOINT) {
      throw new Error('unexpected fetch destination');
    }
    destinations.push(destination);
    const { pathname, search } = new URL(destination);
    return nativeFetch(new URL(pathname + search, origin), init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, destinations };
}

export async function headerResponse(fetchMock: FetchMock): Promise<void> {
  const call = fetchMock.mock.results[0];
  if (call === undefined) {
    throw new Error('fetch was not called');
  }
  await call.value;
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
