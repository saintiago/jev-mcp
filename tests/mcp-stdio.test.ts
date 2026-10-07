import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { IncomingHttpHeaders, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJevClient } from '../src/index.js';
import type { JevRequest, JevResult } from '../src/index.js';
import { batchRequest, batchResponse } from './fixtures.js';
import {
  McpSession,
  readJsonBody,
  textContent,
  type JsonSchema,
  type McpSessionOptions,
} from './mcp-stdio-support.js';
import {
  jsonResponse,
  startLoopbackServer,
  stopLoopbackServer,
  stubFetch,
} from './support.js';

const SYNTHETIC_KEY = 'synthetic-mcp-key';
const PROVIDER_STATE_TEXT = batchRequest.state as string;
const PROTO_KEY = '__proto__';
const PREFIXED_KEY = '\u0000__proto__';

const specialRequest: JevRequest = {
  state: {
    [PROTO_KEY]: { fact: 'retain me' },
    ordinary: 'ok',
    evidence: [[{ [PROTO_KEY]: 'nested array evidence' }]],
  },
  questions: {
    [PROTO_KEY]: {
      type: 'choice',
      instructions: {
        [PROTO_KEY]: { note: 'nested instruction' },
        ordinary: 'plain',
      },
      criteria: { [PROTO_KEY]: 'Keep', ordinary: 'Revise' },
    },
    [PREFIXED_KEY]: {
      type: 'noul',
      instructions: 'Is the note relevant?',
      criteria: { true: { [PROTO_KEY]: 'Yes' } },
    },
  },
};

const specialResponse: JevResult = {
  model: 'jev-1.13.0',
  answers: {
    [PROTO_KEY]: {
      type: 'choice',
      choice: PROTO_KEY,
      probabilities: { [PROTO_KEY]: 0.9, ordinary: 0.1 },
      confidence: 0.8,
    },
    [PREFIXED_KEY]: { type: 'noul', noul: 0.6 },
  },
  usage: { input_tokens: 48, output_tokens: 14 },
};

const soleProtoRequest: JevRequest = {
  state: 'Synthetic support note.',
  questions: {
    [PROTO_KEY]: { type: 'noul', instructions: 'Is the note relevant?' },
  },
};

const soleProtoResponse: JevResult = {
  model: 'jev-1.13.0',
  answers: { [PROTO_KEY]: { type: 'noul', noul: 0.4 } },
  usage: { input_tokens: 9, output_tokens: 4 },
};

const sessions: McpSession[] = [];
const servers: Server[] = [];
const usageDirs: string[] = [];

async function tempUsageDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-mcp-usage-'));
  usageDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (sessions.length > 0) {
    sessions.pop()?.kill();
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await stopLoopbackServer(server);
    }
  }
  while (usageDirs.length > 0) {
    const dir = usageDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function startSession(
  options: McpSessionOptions = {},
): Promise<McpSession> {
  const session = await McpSession.start(options);
  sessions.push(session);
  return session;
}

async function startStalledFixture(): Promise<{
  origin: string;
  seen: ReturnType<typeof deferred>;
  aborted: ReturnType<typeof deferred>;
}> {
  const seen = deferred();
  const aborted = deferred();
  const { server, origin } = await startLoopbackServer((_request, response) => {
    seen.resolve();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    response.write('{"model":"jev-1.13.0"');
    response.on('close', () => {
      if (!response.writableEnded) {
        aborted.resolve();
      }
    });
  });
  servers.push(server);
  return { origin, seen, aborted };
}

describe('stdio startup configuration', () => {
  it('fails clearly and quietly without JEV_API_KEY', async () => {
    for (const env of [{}, { JEV_API_KEY: '' }]) {
      const session = await startSession({ usePreload: false, env });
      const exit = await session.waitForExit();
      expect(exit.code).toBe(1);
      expect(exit.signal).toBeNull();
      expect(session.stderr).toContain('JEV_API_KEY');
      expect(session.stdoutLines).toEqual([]);
    }
  });

  it('rejects an empty or trailing-text JEV_TIMEOUT_MS without exposing the key', async () => {
    for (const value of ['', '1500ms']) {
      const session = await startSession({
        usePreload: false,
        env: { JEV_API_KEY: SYNTHETIC_KEY, JEV_TIMEOUT_MS: value },
      });
      const exit = await session.waitForExit();
      expect(exit.code).toBe(1);
      expect(session.stderr).toContain('JEV_TIMEOUT_MS');
      expect(session.stderr).not.toContain(SYNTHETIC_KEY);
      expect(session.stdoutLines).toEqual([]);
    }
  });

  it('reports other invalid configuration with one safe diagnostic', async () => {
    for (const env of [
      { JEV_API_KEY: SYNTHETIC_KEY, JEV_MODEL: '' },
      { JEV_API_KEY: SYNTHETIC_KEY, JEV_TIMEOUT_MS: '0' },
    ]) {
      const session = await startSession({ usePreload: false, env });
      const exit = await session.waitForExit();
      expect(exit).toEqual({ code: 1, signal: null });
      expect(session.stderr).toContain(
        'The JEv client configuration is invalid.',
      );
      expect(session.stderr).not.toContain('JEV_TIMEOUT_MS');
      expect(session.stderr).not.toContain(SYNTHETIC_KEY);
      expect(session.stdoutLines).toEqual([]);
    }
  });

  it('does not attribute another invalid setting to a valid JEV_TIMEOUT_MS', async () => {
    for (const env of [
      { JEV_API_KEY: SYNTHETIC_KEY, JEV_MODEL: '', JEV_TIMEOUT_MS: '1000' },
      { JEV_API_KEY: `${SYNTHETIC_KEY}\u0001`, JEV_TIMEOUT_MS: '1000' },
    ]) {
      const session = await startSession({ usePreload: false, env });
      const exit = await session.waitForExit();
      expect(exit).toEqual({ code: 1, signal: null });
      expect(session.stderr).toContain(
        'The JEv client configuration is invalid.',
      );
      expect(session.stderr).not.toContain('JEV_TIMEOUT_MS');
      expect(session.stderr).not.toContain(SYNTHETIC_KEY);
      expect(session.stdoutLines).toEqual([]);
    }
  });

  it('rejects an empty JEV_USAGE_LOG_PATH and ignores the caller label without a path', async () => {
    const session = await startSession({
      usePreload: false,
      env: { JEV_API_KEY: SYNTHETIC_KEY, JEV_USAGE_LOG_PATH: '' },
    });
    const exit = await session.waitForExit();
    expect(exit).toEqual({ code: 1, signal: null });
    expect(session.stderr).toContain('JEV_USAGE_LOG_PATH');
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
    expect(session.stdoutLines).toEqual([]);

    const labelOnly = await startSession({
      usePreload: false,
      env: { JEV_API_KEY: SYNTHETIC_KEY, JEV_USAGE_LOG_CALLER: 'ghost' },
    });
    await labelOnly.initialize();
    const { tools } = await labelOnly.listTools();
    expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('stdio tool contract', () => {
  it('initializes and exposes exactly one ask_jev tool with shared schemas and guidance', async () => {
    const session = await startSession({ env: { JEV_API_KEY: SYNTHETIC_KEY } });
    const init = await session.initialize();
    expect(init.serverInfo.name).toBe('jev-mcp');

    const { tools } = await session.listTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(tool.name).toBe('ask_jev');
    const description = String(tool.description);
    for (const guidance of [
      'TypeSafe',
      'usage logging',
      'local JSONL usage record',
      'narrow questions',
      'explicit alternatives',
      'relevant evidence',
      'batch',
      'judgments, not code or prose answers',
      'deterministic tools',
      'Confidence',
    ]) {
      expect(description).toContain(guidance);
    }
    expect(tool.annotations?.readOnlyHint).toBe(true);

    expect([...(tool.inputSchema.required ?? [])].sort()).toEqual([
      'questions',
      'state',
    ]);
    expect(tool.inputSchema.additionalProperties).toBe(false);
    expect(tool.inputSchema.properties?.questions?.type).toBe('object');
    const alternatives = tool.inputSchema.properties?.questions
      ?.additionalProperties as JsonSchema | undefined;
    expect(alternatives?.oneOf).toHaveLength(3);

    expect([...(tool.outputSchema?.required ?? [])].sort()).toEqual([
      'answers',
      'model',
      'usage',
    ]);
    const answerVariants = tool.outputSchema?.properties?.answers
      ?.additionalProperties as JsonSchema | undefined;
    expect(answerVariants?.oneOf).toHaveLength(3);
    expect(session.stdoutAsProtocolOnly()).toBe(true);
  }, 15000);

  it('returns API-equivalent structured content and JSON text for a fixture batch', async () => {
    const requests: Array<{ headers: IncomingHttpHeaders; body: unknown }> = [];
    const { server, origin } = await startLoopbackServer(
      async (request, response) => {
        requests.push({
          headers: request.headers,
          body: await readJsonBody(request),
        });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(batchResponse));
      },
    );
    servers.push(server);

    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY },
    });
    await session.initialize();

    const { response } = session.callTool(batchRequest);
    const result = await response;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(batchResponse);
    expect(JSON.parse(textContent(result))).toEqual(batchResponse);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${SYNTHETIC_KEY}`);
    expect(requests[0]?.body).toEqual({
      state: batchRequest.state,
      model: 'jev-1.13.0',
      questions: batchRequest.questions,
    });

    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(batchResponse)),
    );
    const apiResult = await createJevClient({ apiKey: SYNTHETIC_KEY }).evaluate(
      batchRequest,
    );
    expect(result.structuredContent).toEqual(apiResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.stdoutAsProtocolOnly()).toBe(true);
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
  }, 15000);

  it('preserves arbitrary map keys through validation and returns them', async () => {
    const requests: unknown[] = [];
    const { server, origin } = await startLoopbackServer(
      async (request, response) => {
        requests.push(await readJsonBody(request));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(specialResponse));
      },
    );
    servers.push(server);

    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY },
    });
    await session.initialize();

    const result = await session.callTool(specialRequest).response;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(specialResponse);
    expect(JSON.parse(textContent(result))).toEqual(specialResponse);

    expect(requests).toHaveLength(1);
    const payload = requests[0] as {
      state: Record<string, unknown>;
      questions: Record<string, unknown>;
    };
    expect(Object.hasOwn(payload.state, PROTO_KEY)).toBe(true);
    expect(Object.hasOwn(payload.state, 'ordinary')).toBe(true);
    expect(payload.state[PROTO_KEY]).toEqual({ fact: 'retain me' });
    expect(payload.state.evidence).toEqual([
      [{ [PROTO_KEY]: 'nested array evidence' }],
    ]);
    const choice = payload.questions[PROTO_KEY] as {
      instructions: Record<string, unknown>;
      criteria: Record<string, unknown>;
    };
    expect(choice.criteria).toEqual({
      [PROTO_KEY]: 'Keep',
      ordinary: 'Revise',
    });
    expect(choice.instructions).toEqual({
      [PROTO_KEY]: { note: 'nested instruction' },
      ordinary: 'plain',
    });
    expect(Object.hasOwn(payload.questions, PREFIXED_KEY)).toBe(true);
    expect(JSON.stringify(payload)).toContain('"__proto__"');

    const fetchMock = stubFetch(() =>
      Promise.resolve(jsonResponse(specialResponse)),
    );
    const apiResult = await createJevClient({ apiKey: SYNTHETIC_KEY }).evaluate(
      specialRequest,
    );
    expect(result.structuredContent).toEqual(apiResult);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(session.stdoutAsProtocolOnly()).toBe(true);
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
  }, 15000);

  it('accepts a request whose only question id is a special key', async () => {
    const requests: unknown[] = [];
    const { server, origin } = await startLoopbackServer(
      async (request, response) => {
        requests.push(await readJsonBody(request));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(soleProtoResponse));
      },
    );
    servers.push(server);

    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY },
    });
    await session.initialize();

    const result = await session.callTool(soleProtoRequest).response;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(soleProtoResponse);
    const payload = requests[0] as {
      state: unknown;
      questions: Record<string, unknown>;
    };
    expect(payload.state).toBe(soleProtoRequest.state);
    expect(Object.hasOwn(payload.questions, PROTO_KEY)).toBe(true);
    expect(session.stdoutAsProtocolOnly()).toBe(true);
  }, 15000);

  it('uses JEV_MODEL and JEV_TIMEOUT_MS from the environment', async () => {
    const requests: unknown[] = [];
    const { server, origin } = await startLoopbackServer(
      async (request, response) => {
        requests.push(await readJsonBody(request));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(batchResponse));
      },
    );
    servers.push(server);

    const session = await startSession({
      providerOrigin: origin,
      env: {
        JEV_API_KEY: SYNTHETIC_KEY,
        JEV_MODEL: 'jev-test-model',
        JEV_TIMEOUT_MS: '1000',
      },
    });
    await session.initialize();

    const result = await session.callTool(batchRequest).response;
    expect(result.isError).toBeFalsy();
    expect((requests[0] as { model: string }).model).toBe('jev-test-model');
  }, 15000);

  it('applies the configured timeout to a stalled provider body', async () => {
    const { origin, seen } = await startStalledFixture();
    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY, JEV_TIMEOUT_MS: '300' },
    });
    await session.initialize();

    const result = await session.callTool(batchRequest).response;
    await seen;
    expect(result.isError).toBe(true);
    const text = textContent(result);
    expect(text).toContain('timeout');
    expect(text).toContain('The request timed out.');
  }, 15000);
});

describe('stdio failures and cancellation', () => {
  it('returns isError with the safe code, message and status without leaking evidence', async () => {
    let call = 0;
    const { server, origin } = await startLoopbackServer(
      (_request, response) => {
        call += 1;
        const status = call === 1 ? 429 : 500;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            providerBody: PROVIDER_STATE_TEXT,
            key: SYNTHETIC_KEY,
          }),
        );
      },
    );
    servers.push(server);

    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY },
    });
    await session.initialize();

    const rateLimited = await session.callTool(batchRequest).response;
    expect(rateLimited.isError).toBe(true);
    const rateLimitedText = textContent(rateLimited);
    expect(rateLimitedText).toContain('rate_limited');
    expect(rateLimitedText).toContain('The rate limit was exceeded.');
    expect(rateLimitedText).toContain('429');
    expect(rateLimitedText).not.toContain(PROVIDER_STATE_TEXT);
    expect(rateLimitedText).not.toContain(SYNTHETIC_KEY);

    const unavailable = await session.callTool(batchRequest).response;
    expect(unavailable.isError).toBe(true);
    const unavailableText = textContent(unavailable);
    expect(unavailableText).toContain('unavailable');
    expect(unavailableText).toContain('The service is unavailable.');
    expect(unavailableText).toContain('500');
    expect(unavailableText).not.toContain(SYNTHETIC_KEY);

    expect(session.stdoutAsProtocolOnly()).toBe(true);
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
  }, 15000);

  it('rejects tool arguments that try to supply credentials, an endpoint or a path', async () => {
    const requests: unknown[] = [];
    const { server, origin } = await startLoopbackServer(
      async (request, response) => {
        requests.push(await readJsonBody(request));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(batchResponse));
      },
    );
    servers.push(server);

    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY },
    });
    await session.initialize();

    const result = await session.callTool({
      ...batchRequest,
      apiKey: SYNTHETIC_KEY,
      endpoint: 'https://example.invalid',
      path: '/etc/passwd',
    }).response;
    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain('Input validation error');
    expect(requests).toEqual([]);
  }, 15000);

  it('propagates SDK cancellation to the outstanding provider call', async () => {
    const { origin, seen, aborted } = await startStalledFixture();
    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY, JEV_TIMEOUT_MS: '60000' },
    });
    await session.initialize();

    const call = session.callTool(batchRequest, 30000);
    await seen.promise;
    session.cancel(call.id, 'test cancellation');
    await aborted.promise;

    const { tools } = await session.listTools();
    expect(tools).toHaveLength(1);
    expect(session.exited).toBeUndefined();
  }, 15000);
});

describe('stdio usage logging', () => {
  it('advertises the host-enabled usage write as a non-read-only tool', async () => {
    const dir = await tempUsageDir();
    const path = join(dir, 'usage.jsonl');
    const session = await startSession({
      env: {
        JEV_API_KEY: SYNTHETIC_KEY,
        JEV_USAGE_LOG_PATH: path,
        JEV_USAGE_LOG_CALLER: 'mcp-agent',
      },
    });
    await session.initialize();

    const { tools } = await session.listTools();
    expect(tools).toHaveLength(1);
    const tool = tools[0]!;
    expect(String(tool.description)).toContain(
      'appends one local JSONL usage record per evaluation',
    );
    expect(tool.annotations?.readOnlyHint).toBe(false);
    expect(existsSync(path)).toBe(false);
    expect(session.stdoutAsProtocolOnly()).toBe(true);
  }, 15000);

  it('writes one client-owned record per evaluation without duplicating or changing results', async () => {
    const dir = await tempUsageDir();
    const path = join(dir, 'usage.jsonl');
    await writeFile(path, '{"existing":true}\n');
    let call = 0;
    const { server, origin } = await startLoopbackServer(
      (_request, response) => {
        call += 1;
        if (call === 1) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(batchResponse));
          return;
        }
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: PROVIDER_STATE_TEXT }));
      },
    );
    servers.push(server);

    const session = await startSession({
      providerOrigin: origin,
      env: {
        JEV_API_KEY: SYNTHETIC_KEY,
        JEV_USAGE_LOG_PATH: path,
        JEV_USAGE_LOG_CALLER: 'mcp-agent',
      },
    });
    await session.initialize();

    const succeeded = await session.callTool(batchRequest).response;
    expect(succeeded.isError).toBeFalsy();
    expect(succeeded.structuredContent).toEqual(batchResponse);

    const failed = await session.callTool(batchRequest).response;
    expect(failed.isError).toBe(true);
    expect(textContent(failed)).toContain('rate_limited');

    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('{"existing":true}');
    const success = JSON.parse(lines[1] ?? '') as Record<string, unknown>;
    expect(success.questions).toEqual(batchRequest.questions);
    expect(success.answers).toEqual(batchResponse.answers);
    expect(success.usage).toEqual(batchResponse.usage);
    expect(success.model).toBe(batchResponse.model);
    expect(success.caller).toBe('mcp-agent');
    expect(success.errorCode).toBeUndefined();
    const failure = JSON.parse(lines[2] ?? '') as Record<string, unknown>;
    expect(failure.errorCode).toBe('rate_limited');
    expect(failure.model).toBe('jev-1.13.0');
    expect(failure.questions).toEqual(batchRequest.questions);
    expect(failure.answers).toBeUndefined();
    const content = await readFile(path, 'utf8');
    expect(content).not.toContain(PROVIDER_STATE_TEXT);
    expect(content).not.toContain(SYNTHETIC_KEY);
    expect(session.stdoutAsProtocolOnly()).toBe(true);
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
  }, 15000);

  it('keeps MCP results and safe errors when the usage destination cannot be written', async () => {
    const dir = await tempUsageDir();
    const path = join(dir, 'missing', 'usage.jsonl');
    let call = 0;
    const { server, origin } = await startLoopbackServer(
      (_request, response) => {
        call += 1;
        if (call === 1) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(batchResponse));
          return;
        }
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ detail: PROVIDER_STATE_TEXT }));
      },
    );
    servers.push(server);

    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY, JEV_USAGE_LOG_PATH: path },
    });
    await session.initialize();

    const succeeded = await session.callTool(batchRequest).response;
    expect(succeeded.isError).toBeFalsy();
    expect(succeeded.structuredContent).toEqual(batchResponse);

    const failed = await session.callTool(batchRequest).response;
    expect(failed.isError).toBe(true);
    expect(textContent(failed)).toContain('rate_limited');

    expect(existsSync(path)).toBe(false);
    expect(session.stdoutAsProtocolOnly()).toBe(true);
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
    expect(session.stderr).not.toContain(path);
  }, 15000);
});

describe('stdio shutdown', () => {
  it('closes on stdin EOF before a session is established', async () => {
    const session = await startSession({
      usePreload: false,
      env: { JEV_API_KEY: SYNTHETIC_KEY },
    });
    session.endStdin();
    const exit = await session.waitForExit(5000);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(session.stdoutLines).toEqual([]);
  }, 15000);

  it('closes on stdin EOF and aborts an outstanding provider call', async () => {
    const { origin, seen, aborted } = await startStalledFixture();
    const session = await startSession({
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY, JEV_TIMEOUT_MS: '60000' },
    });
    await session.initialize();

    session.callTool(batchRequest, 30000);
    await seen.promise;
    session.endStdin();

    const exit = await session.waitForExit(5000);
    expect(exit).toEqual({ code: 0, signal: null });
    await aborted.promise;
    expect(session.stdoutAsProtocolOnly()).toBe(true);
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
  }, 15000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    it(`closes on ${signal} and aborts an outstanding provider call`, async () => {
      const { origin, seen, aborted } = await startStalledFixture();
      const session = await startSession({
        providerOrigin: origin,
        env: { JEV_API_KEY: SYNTHETIC_KEY, JEV_TIMEOUT_MS: '60000' },
      });
      await session.initialize();

      session.callTool(batchRequest, 30000);
      await seen.promise;
      session.kill(signal);

      const exit = await session.waitForExit(5000);
      expect(exit).toEqual({ code: 0, signal: null });
      await aborted.promise;
      expect(session.stdoutAsProtocolOnly()).toBe(true);
    }, 15000);
  }
});
