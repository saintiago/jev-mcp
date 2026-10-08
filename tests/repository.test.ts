import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRepositoryClient,
  createJevClient,
  JevError,
} from '../src/index.js';
import type { JevClient, JevRequest } from '../src/index.js';
let root: string;
let requests: JevRequest[];
let client: JevClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-repository-'));
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
  await writeFile(path.join(root, '.gitignore'), 'ignored.ts\n');
  await writeFile(
    path.join(root, 'camera.ts'),
    'export async function openCamera() { return navigator.mediaDevices.getUserMedia({video:true}); }\n// END-OF-WHOLE-FILE',
  );
  await writeFile(path.join(root, 'other.ts'), 'export const unrelated = 1;');
  requests = [];
  client = {
    evaluate: async (request) => {
      requests.push(request);
      return {
        model: 'jev-1.13.0',
        answers: Object.fromEntries(
          Object.keys(request.questions).map((id) => [
            id,
            {
              type: 'noul' as const,
              noul:
                typeof request.state === 'object' &&
                !Array.isArray(request.state) &&
                request.state['path'] === 'other.ts'
                  ? 0.05
                  : 0.92,
            },
          ]),
        ),
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
  };
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
describe('repository public boundary', () => {
  it('uses literal lookup without provider calls and returns no source', async () => {
    const result = await createRepositoryClient(client, root).searchRepo({
      query: 'getUserMedia',
    });
    expect(result.files).toEqual([{ path: 'camera.ts', score: 1 }]);
    expect(result.usage.calls).toBe(0);
    expect(requests).toHaveLength(0);
    expect(JSON.stringify(result)).not.toContain('END-OF-WHOLE-FILE');
    expect(result.source.workingTreeDirty).toBe(true);
    expect(result.source.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('screens concept candidates then verifies entire files', async () => {
    const result = await createRepositoryClient(client, root).searchRepo({
      query: 'Where does the browser open its camera?',
    });
    expect(result.files.some((f) => f.path === 'camera.ts')).toBe(true);
    expect(result.files.some((f) => f.path === 'other.ts')).toBe(false);
    expect(
      requests.some((r) =>
        JSON.stringify(r.state).includes('END-OF-WHOLE-FILE'),
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain('navigator.mediaDevices');
  });
  it('returns per-file bounded criteria without generated reasons', async () => {
    const result = await createRepositoryClient(client, root).inspectFiles({
      paths: ['camera.ts', 'other.ts'],
      questions: [
        { id: 'camera', question: 'Does this implement camera acquisition?' },
      ],
    });
    expect(result.files[0]?.assessments[0]).toMatchObject({
      id: 'camera',
      score: 0.92,
      assessment: 'evidence',
    });
    expect(result.files[1]?.assessments[0]?.assessment).toBe('not_found');
    expect(result.coverage.complete).toBe(true);
    expect(JSON.stringify(result)).not.toContain('END-OF-WHOLE-FILE');
  });
  it('rejects traversal, absolute paths and escaping symlinks before provider calls', async () => {
    await symlink('/etc/hosts', path.join(root, 'escape.ts'));
    for (const file of ['../outside.ts', '/etc/hosts', 'escape.ts'])
      await expect(
        createRepositoryClient(client, root).inspectFiles({
          paths: ['camera.ts', file],
          questions: [{ id: 'x', question: 'Is this relevant?' }],
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(requests).toHaveLength(0);
  });
  it('reports ignored, binary, oversized and missing files without reading prefixes', async () => {
    await writeFile(path.join(root, 'ignored.ts'), 'ignored');
    await writeFile(path.join(root, 'binary'), 'a\0b');
    await writeFile(path.join(root, 'large.ts'), 'x'.repeat(128001));
    const result = await createRepositoryClient(client, root).inspectFiles({
      paths: ['ignored.ts', 'binary', 'large.ts', 'missing.ts'],
      questions: [{ id: 'x', question: 'Is this relevant?' }],
    });
    expect(result.files).toEqual([]);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.skipped.map((f) => f.reason).sort()).toEqual([
      'binary',
      'ignored',
      'too_large',
      'unreadable',
    ]);
    expect(requests).toHaveLength(0);
  });
  it('rejects duplicate question IDs and respects cancellation', async () => {
    await expect(
      createRepositoryClient(client, root).inspectFiles({
        paths: ['camera.ts'],
        questions: [
          { id: 'x', question: 'a' },
          { id: 'x', question: 'b' },
        ],
      }),
    ).rejects.toBeInstanceOf(JevError);
    const controller = new AbortController();
    controller.abort();
    await expect(
      createRepositoryClient(client, root).searchRepo(
        { query: 'camera' },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('repository source and usage-log privacy', () => {
  it('skips aliases of ignored files for both tools', async () => {
    await writeFile(path.join(root, 'ignored.ts'), 'PRIVATE_IGNORED_CONTENT');
    await symlink('ignored.ts', path.join(root, 'alias.ts'));
    const repo = createRepositoryClient(client, root);
    const inspected = await repo.inspectFiles({
      paths: ['alias.ts'],
      questions: [{ id: 'x', question: 'Does it implement acquisition?' }],
    });
    const searched = await repo.searchRepo({
      query: 'Where is acquisition implemented?',
    });
    for (const result of [inspected, searched])
      expect(result.coverage.skipped).toContainEqual({
        path: 'alias.ts',
        reason: 'ignored',
      });
    expect(inspected.files).toEqual([]);
    expect(JSON.stringify(requests)).not.toContain('PRIVATE_IGNORED_CONTENT');
  });
  for (const fail of [false, true]) {
    for (const tool of ['search', 'inspect']) {
      it(
        'omits question text from ' +
          tool +
          ' usage logs on ' +
          (fail ? 'failure' : 'success'),
        async () => {
          const logPath = path.join(tmpdir(), path.basename(root) + '.jsonl');
          vi.stubGlobal('fetch', async (_url: unknown, init: RequestInit) => {
            if (fail) return new Response('{}', { status: 429 });
            const body = JSON.parse(init.body as string) as {
              questions: Record<string, unknown>;
            };
            return new Response(
              JSON.stringify({
                model: 'jev-1.13.0',
                answers: Object.fromEntries(
                  Object.keys(body.questions).map((id) => [
                    id,
                    { type: 'noul', noul: 0.92 },
                  ]),
                ),
                usage: { input_tokens: 10, output_tokens: 2 },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          });
          const repo = createRepositoryClient(
            createJevClient({
              apiKey: 'synthetic',
              usageLog: { path: logPath },
            }),
            root,
          );
          const marker = 'PRIVATE_QUERY_MARKER';
          try {
            const operation =
              tool === 'search'
                ? repo.searchRepo(
                    { query: 'Find usage of ' + marker },
                    { logQuestions: true },
                  )
                : repo.inspectFiles(
                    {
                      paths: ['camera.ts'],
                      questions: [
                        { id: 'x', question: 'Does it use ' + marker + '?' },
                      ],
                    },
                    { logQuestions: true },
                  );
            const result = await operation;
            if (fail) {
              expect(result.files).toEqual([]);
              expect(result.coverage.complete).toBe(false);
              expect(
                result.coverage.skipped.every(
                  (f) => f.reason === 'evaluation_failed',
                ),
              ).toBe(true);
            }
            const logged = await readFile(logPath, 'utf8');
            expect(logged).not.toContain(marker);
            const records = logged
              .trim()
              .split('\n')
              .map((line) => JSON.parse(line) as Record<string, unknown>);
            expect(records.length).toBeGreaterThan(0);
            for (const record of records) {
              expect(record).not.toHaveProperty('questions');
              expect(record).toHaveProperty(fail ? 'errorCode' : 'usage');
            }
          } finally {
            await rm(logPath, { force: true });
          }
        },
      );
    }
  }
});

describe('repository transient failures', () => {
  for (const error of [
    new JevError('timeout'),
    new JevError('rate_limited', 429),
    new JevError('unavailable', 529),
    new JevError('unavailable', 200),
    new JevError('unavailable'),
  ]) {
    it(
      'retries once and recovers from ' + error.code + '/' + error.status,
      async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const original = client.evaluate;
        let calls = 0;
        client.evaluate = async (request, options) => {
          if (++calls === 1) throw error;
          return original(request, options);
        };
        const result = await createRepositoryClient(client, root).inspectFiles({
          paths: ['camera.ts'],
          questions: [
            { id: 'camera', question: 'Does this acquire the camera?' },
          ],
        });
        expect(calls).toBe(2);
        expect(result.usage).toEqual({
          calls: 2,
          input_tokens: 10,
          output_tokens: 2,
        });
        expect(result.coverage.complete).toBe(true);
        expect(result.files[0]?.assessments[0]?.assessment).toBe('evidence');
      },
    );
  }
  it('preserves successful files after retry exhaustion without negative assessments', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const original = client.evaluate;
    let failures = 0;
    client.evaluate = async (request, options) => {
      if ((request.state as { path: string }).path === 'other.ts') {
        failures++;
        throw new JevError('unavailable', 503);
      }
      return original(request, options);
    };
    const result = await createRepositoryClient(client, root).inspectFiles({
      paths: ['camera.ts', 'other.ts'],
      questions: [{ id: 'x', question: 'Does this acquire the camera?' }],
    });
    expect(failures).toBe(2);
    expect(result.files.map((f) => f.path)).toEqual(['camera.ts']);
    expect(result.coverage).toMatchObject({
      filesInspected: 1,
      complete: false,
      skipped: [
        {
          path: 'other.ts',
          reason: 'evaluation_failed',
          errorCode: 'unavailable',
        },
      ],
    });
    expect(result.usage.calls).toBe(3);
  });
  it('preserves search results when a candidate batch fails', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    for (let i = 0; i < 24; i++)
      await writeFile(
        path.join(root, 'z' + i.toString().padStart(2, '0') + '.ts'),
        'export const x = 1;',
      );
    const original = client.evaluate;
    client.evaluate = async (request, options) => {
      const state = request.state as { candidates?: { path: string }[] };
      if (state.candidates?.some((c) => c.path === 'z10.ts'))
        throw new JevError('timeout');
      return original(request, options);
    };
    const result = await createRepositoryClient(client, root).searchRepo({
      query: 'Where does browser camera acquisition happen?',
    });
    expect(result.files.some((f) => f.path === 'camera.ts')).toBe(true);
    expect(result.coverage.complete).toBe(false);
    expect(result.coverage.skipped).toHaveLength(12);
    expect(
      result.coverage.skipped.every(
        (f) => f.reason === 'evaluation_failed' && f.errorCode === 'timeout',
      ),
    ).toBe(true);
    expect(result.coverage.skipped.some((f) => f.path === 'z10.ts')).toBe(true);
  });
  it('preserves search hits when a whole-file judgment fails', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const original = client.evaluate;
    client.evaluate = async (request, options) => {
      if ((request.state as { path?: string }).path === 'other.ts')
        throw new JevError('timeout');
      return original(request, options);
    };
    const result = await createRepositoryClient(client, root).searchRepo({
      query: 'Where is camera acquisition implemented?',
    });
    expect(result.files.some((f) => f.path === 'camera.ts')).toBe(true);
    expect(result.coverage.skipped).toContainEqual({
      path: 'other.ts',
      reason: 'evaluation_failed',
      errorCode: 'timeout',
    });
    expect(result.coverage.complete).toBe(false);
  });
  for (const error of [
    new JevError('authentication', 401),
    new JevError('invalid_input', 422),
    new JevError('cancelled'),
  ]) {
    it('propagates ' + error.code + ' without retrying', async () => {
      const evaluate = vi.fn(async () => {
        throw error;
      });
      client.evaluate = evaluate;
      await expect(
        createRepositoryClient(client, root).inspectFiles({
          paths: ['camera.ts'],
          questions: [{ id: 'x', question: 'Is this relevant?' }],
        }),
      ).rejects.toBe(error);
      expect(evaluate).toHaveBeenCalledTimes(1);
    });
  }
  it('does not retry malformed responses or permanent unavailable responses', async () => {
    for (const error of [
      new JevError('invalid_response'),
      new JevError('unavailable', 307),
    ]) {
      const evaluate = vi.fn(async () => {
        throw error;
      });
      const result = await createRepositoryClient(
        { evaluate },
        root,
      ).inspectFiles({
        paths: ['camera.ts'],
        questions: [{ id: 'x', question: 'Is this relevant?' }],
      });
      expect(evaluate).toHaveBeenCalledTimes(1);
      expect(result.files).toEqual([]);
      expect(result.coverage.skipped[0]).toMatchObject({
        reason: 'evaluation_failed',
        errorCode: error.code,
      });
    }
  });
  it('cancels during retry delay without starting a second evaluation', async () => {
    const controller = new AbortController();
    const evaluate = vi.fn(async () => {
      setTimeout(() => controller.abort(), 10);
      throw new JevError('timeout');
    });
    await expect(
      createRepositoryClient({ evaluate }, root).inspectFiles(
        {
          paths: ['camera.ts'],
          questions: [{ id: 'x', question: 'Is this relevant?' }],
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
});

it('retries a connection drop while reading a successful HTTP response', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => {
        throw new TypeError('terminated');
      },
    })
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          model: 'jev-1.13.0',
          answers: { q0: { type: 'noul', noul: 0.92 } },
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
  vi.stubGlobal('fetch', fetchMock);
  const repo = createRepositoryClient(
    createJevClient({ apiKey: 'synthetic' }),
    root,
  );
  const result = await repo.inspectFiles({
    paths: ['camera.ts'],
    questions: [{ id: 'x', question: 'Does this acquire the camera?' }],
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.coverage.complete).toBe(true);
  expect(result.files[0]?.assessments[0]?.assessment).toBe('evidence');
});
