import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpSession, readJsonBody, textContent } from './mcp-stdio-support.js';
import { startLoopbackServer, stopLoopbackServer } from './support.js';
import type { Server } from 'node:http';
let root: string;
let sessions: McpSession[] = [];
let providers: Server[] = [];
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-stdio-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'init',
    ],
    { cwd: root },
  );
  await writeFile(
    path.join(root, 'camera.ts'),
    'export const camera = "whole-file-marker";',
  );
});
afterEach(async () => {
  for (const s of sessions) {
    s.endStdin();
    await s.waitForExit();
  }
  sessions = [];
  await Promise.all(providers.map(stopLoopbackServer));
  providers = [];
  await rm(root, { recursive: true, force: true });
});
async function session(status = 200) {
  const provider = await startLoopbackServer((request, response) => {
    void (async () => {
      const body = (await readJsonBody(request)) as {
        questions: Record<string, unknown>;
      };
      response.writeHead(status, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: Object.fromEntries(
            Object.keys(body.questions).map((id) => [
              id,
              { type: 'noul', noul: 0.9 },
            ]),
          ),
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
      );
    })();
  });
  providers.push(provider.server);
  const s = await McpSession.start({
    cwd: root,
    providerOrigin: provider.origin,
    env: { JEV_API_KEY: 'synthetic-key' },
  });
  sessions.push(s);
  await s.initialize();
  return s;
}
describe('evidence tools over stdio', () => {
  it('advertises only the replacement interface', async () => {
    const s = await session();
    expect((await s.listTools()).tools.map((t) => t.name)).toEqual([
      'retrieve_evidence',
      'expand_evidence',
    ]);
  });
  it('returns original source and line bounds over protocol-only stdout', async () => {
    const s = await session();
    const r = await s.callTool({
      requests: [{ path: 'camera.ts', full: true }],
    }).response;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      windows: [
        {
          path: 'camera.ts',
          start: 1,
          end: 1,
          text: 'export const camera = "whole-file-marker";',
        },
      ],
    });
    expect(s.stdoutAsProtocolOnly()).toBe(true);
  });
  it('supports deterministic retrieval with a failing provider', async () => {
    const s = await session(503);
    const r = await s.callTool(
      { terms: ['camera'] },
      undefined,
      'retrieve_evidence',
    ).response;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      method: 'exact',
      usage: { calls: 0 },
    });
  });
  it('retrieves conceptual evidence through JEv', async () => {
    const s = await session();
    const r = await s.callTool(
      { question: 'Where is camera acquisition?' },
      undefined,
      'retrieve_evidence',
    ).response;
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      method: 'semantic',
      windows: [{ path: 'camera.ts' }],
    });
  });
  it('reports safe partial provider failures while allowing unfiltered expansion', async () => {
    const s = await session(503);
    const r = await s.callTool(
      { question: 'Find media' },
      undefined,
      'retrieve_evidence',
    ).response;
    expect(r.structuredContent).toMatchObject({
      windows: [],
      coverage: { complete: false },
      usage: { calls: 2 },
    });
    expect(
      (
        await s.callTool({ requests: [{ path: 'camera.ts', full: true }] })
          .response
      ).isError,
    ).toBeFalsy();
  });
  it('rejects invalid arguments and traversal', async () => {
    const s = await session();
    expect(
      (await s.callTool({ requests: [{ path: '../secret' }] }).response)
        .isError,
    ).toBe(true);
    expect((await s.callTool({ requests: [] }).response).isError).toBe(true);
  });
});
