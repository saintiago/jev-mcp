import { execFileSync } from 'node:child_process';
import {
  mkdtemp,
  writeFile,
  symlink,
  mkdir,
  rm,
  readFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createRepositoryClient, JevError } from '../src/index.js';
import type { JevClient, JevRequest } from '../src/index.js';
let root: string, requests: JevRequest[], client: JevClient;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'jev-evidence-'));
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
    'const camera = true;\nstopStream();\nendMarker();',
  );
  await writeFile(path.join(root, 'other.ts'), 'unrelated');
  requests = [];
  client = {
    evaluate: async (r) => {
      requests.push(r);
      return {
        model: 'jev',
        answers: Object.fromEntries(
          Object.keys(r.questions).map((k) => [
            k,
            { type: 'noul' as const, noul: 0.9 },
          ]),
        ),
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});
it('returns exact source and locations with zero provider calls', async () => {
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    terms: ['stopStream'],
  });
  expect(r.method).toBe('exact');
  expect(requests).toHaveLength(0);
  expect(r.windows).toEqual([
    {
      path: 'camera.ts',
      start: 1,
      end: 3,
      text: 'const camera = true;\nstopStream();\nendMarker();',
    },
  ]);
  expect(r.files[0]).toEqual({
    path: 'camera.ts',
    totalLines: 3,
    omitted: false,
  });
  expect(r.source.root).toBe(root);
  expect(r.source.contentDigest).toMatch(/^[a-f0-9]{64}$/);
});
it('merges overlapping exact windows and batches files', async () => {
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    terms: ['camera', 'stopStream', 'unrelated'],
  });
  expect(r.windows.map((w) => w.path)).toEqual(['camera.ts', 'other.ts']);
  expect(requests).toHaveLength(0);
});
it('returns empty exact results without claiming a semantic proof', async () => {
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    terms: ['ABSENT'],
  });
  expect(r.windows).toEqual([]);
  expect(r.notice).toContain('not evidence of absence');
  expect(requests).toHaveLength(0);
});
it('uses semantic discovery and returns actual evidence, not generated reasons', async () => {
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    question: 'Where are camera resources released?',
  });
  expect(requests.length).toBeGreaterThan(0);
  expect(r.method).toBe('semantic');
  expect(r.windows.some((w) => w.text.includes('stopStream'))).toBe(true);
  expect(r.coverage.complete).toBe(false);
  expect(r.coverage.limits).toContain('semantic_filter');
  expect(r.usage.input_tokens).toBe(requests.length * 10);
});
it('skips semantic screening when exact evidence fits the budget', async () => {
  await createRepositoryClient(client, root).retrieveEvidence({
    question: 'Where is cleanup?',
    terms: ['stopStream'],
  });
  expect(requests).toHaveLength(0);
});
it('bounds returned characters at complete source lines with explicit omissions', async () => {
  await writeFile(
    path.join(root, 'large.ts'),
    Array.from(
      { length: 160 },
      (_, i) => `const match${i} = '${'x'.repeat(30)}';`,
    ).join('\n'),
  );
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    terms: ['match'],
    maxChars: 1000,
  });
  expect(r.windows.reduce((n, w) => n + w.text.length, 0)).toBeLessThanOrEqual(
    1000,
  );
  expect(r.coverage.limits).toContain('budget');
  expect(r.files[0]!.omitted).toBe(true);
  const w = r.windows[0]!;
  expect(w.text.split('\n')).toHaveLength(w.end - w.start + 1);
});
it('expands multiple exact ranges, merges overlap, and never calls JEv', async () => {
  const r = await createRepositoryClient(client, root).expandEvidence({
    requests: [
      { path: 'camera.ts', start: 1, end: 2 },
      { path: 'camera.ts', start: 2, end: 3 },
      { path: 'other.ts', full: true },
    ],
  });
  expect(r.windows).toEqual([
    {
      path: 'camera.ts',
      start: 1,
      end: 3,
      text: 'const camera = true;\nstopStream();\nendMarker();',
    },
    { path: 'other.ts', start: 1, end: 1, text: 'unrelated' },
  ]);
  expect(requests).toHaveLength(0);
});
it('reads an explicit full file beyond discovery limits', async () => {
  const text = 'large\n'.repeat(100000);
  await writeFile(path.join(root, 'large.ts'), text);
  const repo = createRepositoryClient(client, root);
  const r = await repo.retrieveEvidence({ terms: ['large'] });
  expect(r.coverage.skipped).toContainEqual({
    path: 'large.ts',
    reason: 'too_large',
  });
  expect(
    (
      await repo.expandEvidence({
        requests: [{ path: 'large.ts', full: true }],
      })
    ).windows[0]!.text,
  ).toBe(text);
});
it.each(['../outside', '/etc/passwd', 'x\0y'])(
  'rejects escaping input %s before provider use',
  async (p) => {
    const repo = createRepositoryClient(client, root);
    await expect(
      repo.retrieveEvidence({ question: 'find', scope: p }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(
      repo.expandEvidence({ requests: [{ path: p, full: true }] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(requests).toHaveLength(0);
  },
);
it('rejects an escaping symlink and an invalid later request in a batch', async () => {
  await symlink('/etc/passwd', path.join(root, 'alias'));
  await expect(
    createRepositoryClient(client, root).expandEvidence({
      requests: [{ path: 'camera.ts' }, { path: 'alias' }],
    }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
  expect(requests).toHaveLength(0);
});
it('respects ignored files and aliases pointing at them', async () => {
  await writeFile(path.join(root, 'ignored.ts'), 'SECRET');
  await symlink('ignored.ts', path.join(root, 'alias.ts'));
  const r = await createRepositoryClient(client, root).expandEvidence({
    requests: [{ path: 'ignored.ts' }, { path: 'alias.ts' }],
  });
  expect(r.windows).toEqual([]);
  expect(r.coverage.skipped).toHaveLength(2);
  expect(r.coverage.skipped.every((s) => s.reason === 'ignored')).toBe(true);
});
it('reports binary and unreadable source without inventing evidence', async () => {
  await writeFile(path.join(root, 'binary'), Buffer.from([0, 1]));
  const r = await createRepositoryClient(client, root).expandEvidence({
    requests: [{ path: 'binary' }, { path: 'missing' }],
  });
  expect(r.windows).toEqual([]);
  expect(r.coverage.skipped.map((s) => s.reason)).toEqual([
    'binary',
    'unreadable',
  ]);
});
it('treats pathspec metacharacters literally', async () => {
  await mkdir(path.join(root, '[a]'));
  await writeFile(path.join(root, '[a]/file.ts'), 'needle');
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    scope: '[a]',
    terms: ['needle'],
  });
  expect(r.windows[0]?.path).toBe('[a]/file.ts');
});
it('treats shell-looking search terms as literal data', async () => {
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    terms: ['$(touch INJECTED)', '; echo SECRET'],
  });
  expect(r.windows).toEqual([]);
  expect(requests).toHaveLength(0);
});
it.each([
  { requests: [] },
  { requests: [{ path: 'camera.ts', start: 3, end: 1 }] },
  { requests: [{ path: 'camera.ts', full: true, start: 1 }] },
])('rejects invalid expansion contracts', async (r) => {
  await expect(
    createRepositoryClient(client, root).expandEvidence(r),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});
it('rejects empty discovery and out-of-range expansion', async () => {
  const repo = createRepositoryClient(client, root);
  await expect(repo.retrieveEvidence({})).rejects.toMatchObject({
    code: 'invalid_input',
  });
  await expect(
    repo.expandEvidence({ requests: [{ path: 'camera.ts', start: 99 }] }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});
it('retries transient evaluations, retaining partial failures and safe usage', async () => {
  let n = 0;
  client.evaluate = async () => {
    n++;
    throw new JevError('unavailable', 503);
  };
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    question: 'Find cleanup',
  });
  expect(n).toBe(2);
  expect(r.usage.calls).toBe(2);
  expect(r.usage.input_tokens).toBe(0);
  expect(r.coverage.skipped.some((s) => s.reason === 'evaluation_failed')).toBe(
    true,
  );
});
it('propagates auth and cancellation without substituting scores', async () => {
  client.evaluate = async () => {
    throw new JevError('authentication');
  };
  await expect(
    createRepositoryClient(client, root).retrieveEvidence({ question: 'Find' }),
  ).rejects.toMatchObject({ code: 'authentication' });
  const c = new AbortController();
  c.abort();
  await expect(
    createRepositoryClient(client, root).expandEvidence(
      { requests: [{ path: 'camera.ts' }] },
      { signal: c.signal },
    ),
  ).rejects.toMatchObject({ code: 'cancelled' });
});
it('logs only retrieval metadata, never evidence, terms, questions or paths', async () => {
  const log = path.join(root, 'metadata.jsonl');
  await createRepositoryClient(client, root, {
    path: log,
    caller: 'test',
  }).retrieveEvidence({ question: 'PRIVATE QUESTION', terms: ['stopStream'] });
  const text = await readFile(log, 'utf8');
  expect(text).not.toContain('stopStream');
  expect(text).not.toContain('PRIVATE QUESTION');
  expect(text).not.toContain('camera.ts');
  expect(JSON.parse(text).returnedChars).toBeGreaterThan(0);
});
it('keeps retrieval available if metadata logging fails', async () => {
  const r = await createRepositoryClient(client, root, {
    path: '/nonexistent/metadata',
  }).retrieveEvidence({ terms: ['camera'] });
  expect(r.windows).toHaveLength(1);
});

it('skips escaping inventory links while preserving valid discovery evidence', async () => {
  await symlink('/etc/passwd', path.join(root, 'outside.ts'));
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    terms: ['camera'],
  });
  expect(r.windows.some((w) => w.path === 'camera.ts')).toBe(true);
  expect(r.coverage.skipped).toContainEqual({
    path: 'outside.ts',
    reason: 'outside_repository',
  });
});
it('reports invalid UTF-8 rather than inventing replacement source characters', async () => {
  await writeFile(path.join(root, 'invalid.ts'), Buffer.from([0xff]));
  const r = await createRepositoryClient(client, root).expandEvidence({
    requests: [{ path: 'invalid.ts', full: true }],
  });
  expect(r.windows).toEqual([]);
  expect(r.coverage.skipped).toContainEqual({
    path: 'invalid.ts',
    reason: 'binary',
  });
});

it('reserves exact hit lines across uneven files before surrounding context', async () => {
  await writeFile(
    path.join(root, 'a.txt'),
    Array(100)
      .fill('needle' + 'x'.repeat(93))
      .join('\n'),
  );
  await writeFile(path.join(root, 'b.txt'), 'needle B');
  const api = createRepositoryClient(client, root);
  const r = await api.retrieveEvidence({ terms: ['needle'], maxChars: 1000 });
  expect(
    r.windows.some((w) => w.path === 'a.txt' && w.text.includes('needle')),
  ).toBe(true);
  expect(
    r.windows.some((w) => w.path === 'b.txt' && w.text === 'needle B'),
  ).toBe(true);
  await writeFile(
    path.join(root, 'late.txt'),
    [
      ...Array(30).fill('x'.repeat(999)),
      'TARGET',
      ...Array(30).fill('x'.repeat(999)),
    ].join('\n'),
  );
  const late = await api.retrieveEvidence({
    scope: 'late.txt',
    terms: ['TARGET'],
    maxChars: 1000,
  });
  expect(late.windows).toEqual([
    { path: 'late.txt', start: 31, end: 31, text: 'TARGET' },
  ]);
});
it('charges newline characters when adjacent semantic sections merge', async () => {
  await writeFile(
    path.join(root, 'sections.txt'),
    Array(120).fill('123456789').join('\n'),
  );
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    scope: 'sections.txt',
    question: 'Find source',
    maxChars: 1198,
  });
  expect(r.windows.reduce((n, w) => n + w.text.length, 0)).toBeLessThanOrEqual(
    1198,
  );
  expect(r.coverage.limits).toContain('budget');
});
it('expands confined directory aliases together with sibling requests', async () => {
  await mkdir(path.join(root, 'real'));
  await writeFile(path.join(root, 'real/source.txt'), 'source');
  await symlink('real', path.join(root, 'alias'));
  const api = createRepositoryClient(client, root);
  const r = await api.expandEvidence({
    requests: [{ path: 'alias/source.txt' }, { path: 'other.ts' }],
  });
  expect(r.windows.map((w) => w.text)).toEqual(['source', 'unrelated']);
  await writeFile(path.join(root, '.gitignore'), 'real/\n');
  const ignored = await api.expandEvidence({
    requests: [{ path: 'alias/source.txt' }, { path: 'other.ts' }],
  });
  expect(ignored.coverage.skipped).toContainEqual({
    path: 'alias/source.txt',
    reason: 'ignored',
  });
  expect(ignored.windows.map((w) => w.text)).toEqual(['unrelated']);
  await writeFile(path.join(root, '.gitignore'), 'alias\n');
  expect(
    (await api.expandEvidence({ requests: [{ path: 'alias/source.txt' }] }))
      .coverage.skipped,
  ).toContainEqual({ path: 'alias/source.txt', reason: 'ignored' });
});
it.each(['first\nsecond\n', 'first\nsecond', 'first\r\nsecond\r\n'])(
  'counts actual EOF lines while preserving source %j',
  async (text) => {
    await writeFile(path.join(root, 'eof.txt'), text);
    const api = createRepositoryClient(client, root);
    const r = await api.expandEvidence({
      requests: [{ path: 'eof.txt', full: true }],
    });
    expect(r.files).toEqual([
      { path: 'eof.txt', totalLines: 2, omitted: false },
    ]);
    expect(r.windows).toEqual([{ path: 'eof.txt', start: 1, end: 2, text }]);
    await expect(
      api.expandEvidence({ requests: [{ path: 'eof.txt', start: 3 }] }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  },
);
it('represents an empty full file without inventing a source line', async () => {
  await writeFile(path.join(root, 'empty.txt'), '');
  const api = createRepositoryClient(client, root);
  const r = await api.expandEvidence({
    requests: [{ path: 'empty.txt', full: true }],
  });
  expect(r.windows).toEqual([]);
  expect(r.files).toEqual([
    { path: 'empty.txt', totalLines: 0, omitted: false },
  ]);
  await expect(
    api.expandEvidence({ requests: [{ path: 'empty.txt', start: 1 }] }),
  ).rejects.toMatchObject({ code: 'invalid_input' });
});

it('bounds dense exact matches without repeatedly rebuilding entire source', async () => {
  await writeFile(path.join(root, 'dense.txt'), 'hit\n'.repeat(25000));
  const r = await createRepositoryClient(client, root).retrieveEvidence({
    scope: 'dense.txt',
    terms: ['hit'],
    maxChars: 1000,
  });
  expect(r.windows).toEqual([
    {
      path: 'dense.txt',
      start: 1,
      end: 250,
      text: Array(250).fill('hit').join('\n'),
    },
  ]);
  expect(r.coverage.limits).toContain('budget');
}, 2000);
