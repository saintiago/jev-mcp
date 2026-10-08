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
describe('repository tools over stdio', () => {
  it('advertises exactly the replacement tools', async () => {
    const s = await session();
    expect((await s.listTools()).tools.map((t) => t.name)).toEqual([
      'search_repo',
      'inspect_files',
    ]);
  });
  it('returns whole-file assessments without source or reasons', async () => {
    const s = await session();
    const result = await s.callTool({
      paths: ['camera.ts'],
      questions: [
        { id: 'camera', question: 'Does it implement camera acquisition?' },
      ],
    }).response;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      files: [
        { path: 'camera.ts', assessments: [{ id: 'camera', score: 0.9 }] },
      ],
    });
    expect(textContent(result)).not.toContain('whole-file-marker');
    expect(s.stdoutAsProtocolOnly()).toBe(true);
  });
  it('supports literal discovery without a provider request', async () => {
    const s = await session();
    const result = await s.callTool({ query: 'camera' }, 5000, 'search_repo')
      .response;
    expect(result.structuredContent).toMatchObject({
      method: 'literal',
      files: [{ path: 'camera.ts', score: 1 }],
      usage: { calls: 0 },
    });
  });
  it('reports provider failures safely and leaves the server usable', async () => {
    const s = await session(429);
    const error = await s.callTool({
      paths: ['camera.ts'],
      questions: [{ id: 'x', question: 'Is it relevant?' }],
    }).response;
    expect(error.isError).toBe(true);
    expect(textContent(error)).toContain('rate_limited');
    const second = await s.callTool({ query: 'camera' }, 5000, 'search_repo')
      .response;
    expect(second.isError).toBeFalsy();
  });
  it('rejects outside paths without revealing their contents', async () => {
    const s = await session();
    const result = await s.callTool({
      paths: ['../outside'],
      questions: [{ id: 'x', question: 'Is it relevant?' }],
    }).response;
    expect(textContent(result)).toContain('invalid_input');
  });
});

it('EOF cancels an outstanding repository provider call and exits', async () => {
  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const provider = await startLoopbackServer((request) => {
    void readJsonBody(request).then(() => arrived());
  });
  providers.push(provider.server);
  const s = await McpSession.start({
    cwd: root,
    providerOrigin: provider.origin,
    env: { JEV_API_KEY: 'synthetic-key', JEV_TIMEOUT_MS: '30000' },
  });
  await s.initialize();
  const call = s.callTool({
    paths: ['camera.ts'],
    questions: [{ id: 'x', question: 'Is camera acquisition implemented?' }],
  });
  void call.response.catch(() => undefined);
  await arrival;
  s.endStdin();
  expect((await s.waitForExit()).code).toBe(0);
});
