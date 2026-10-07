import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevClient } from '../src/index.js';
import { batchRequest, batchResponse } from './fixtures.js';
import {
  FIXED_ENDPOINT,
  failureOf,
  headerResponse,
  startLoopbackServer,
  stopLoopbackServer,
  stubNativeFetch,
} from './support.js';

const servers: Server[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await stopLoopbackServer(server);
    }
  }
});

async function serve(
  respond: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const { server, origin } = await startLoopbackServer(respond);
  servers.push(server);
  return origin;
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('condition was not met');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe('provider transport', () => {
  it('does not follow a provider redirect and retains the 3xx status', async () => {
    const received: string[] = [];
    const origin = await serve((request, response) => {
      request.resume();
      received.push(request.url ?? '');
      if (request.url === '/v1/systemone') {
        response.writeHead(307, { location: '/redirected' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(batchResponse));
    });
    const { fetchMock, destinations } = stubNativeFetch(origin);
    const client = createJevClient({ apiKey: 'synthetic-key' });

    const error = await failureOf(client.evaluate(batchRequest));

    expect(error.code).toBe('unavailable');
    expect(error.status).toBe(307);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(destinations).toEqual([FIXED_ENDPOINT]);
    expect(received).toEqual(['/v1/systemone']);
  });

  it('times out while a delivered response body stalls', async () => {
    let connectionClosed = false;
    const origin = await serve((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      response.write('{"model":"jev-1.13.0"');
      response.on('close', () => {
        connectionClosed = true;
      });
    });
    const { fetchMock } = stubNativeFetch(origin);
    const client = createJevClient({
      apiKey: 'synthetic-key',
      timeoutMs: 400,
    });

    const outcome = failureOf(client.evaluate(batchRequest));
    await headerResponse(fetchMock);
    const error = await outcome;

    expect(error.code).toBe('timeout');
    expect(error.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => connectionClosed);
    expect(connectionClosed).toBe(true);
  });

  it('cancels while a delivered response body stalls', async () => {
    let connectionClosed = false;
    const origin = await serve((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      response.write('{"model":"jev-1.13.0"');
      response.on('close', () => {
        connectionClosed = true;
      });
    });
    const { fetchMock } = stubNativeFetch(origin);
    const controller = new AbortController();
    const client = createJevClient({
      apiKey: 'synthetic-key',
      timeoutMs: 5000,
    });

    const outcome = failureOf(
      client.evaluate(batchRequest, { signal: controller.signal }),
    );
    await headerResponse(fetchMock);
    controller.abort();
    const error = await outcome;

    expect(error.code).toBe('cancelled');
    expect(error.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => connectionClosed);
    expect(connectionClosed).toBe(true);
  });
});
