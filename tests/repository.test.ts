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
            if (fail) await expect(operation).rejects.toBeInstanceOf(JevError);
            else await operation;
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
