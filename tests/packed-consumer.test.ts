import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { McpSession } from './mcp-stdio-support.js';
const root = fileURLToPath(new URL('..', import.meta.url));
it('installs standalone API declarations and exposes the replacement tools', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'jev-packed-'));
  try {
    const pack = path.join(dir, 'pack'),
      consumer = path.join(dir, 'consumer');
    await mkdir(pack);
    await mkdir(consumer);
    const output = JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', pack], {
        cwd: root,
        encoding: 'utf8',
      }),
    ) as { filename: string }[];
    await writeFile(path.join(consumer, 'package.json'), '{"type":"module"}');
    execFileSync(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        path.join(pack, output[0]!.filename),
      ],
      { cwd: consumer, stdio: 'pipe' },
    );
    await writeFile(
      path.join(consumer, 'check.ts'),
      `import {createRepositoryClient,createJevClient} from '@saintiago/jev'; import type {RepositoryClient,SearchRepoResult} from '@saintiago/jev'; const repo:RepositoryClient=createRepositoryClient(createJevClient({apiKey:'synthetic'}),'.'); const output:Promise<SearchRepoResult>=repo.searchRepo({query:'camera'}); void output;`,
    );
    execFileSync(
      process.execPath,
      [
        path.join(root, 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--skipLibCheck',
        '--target',
        'ES2023',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        path.join(consumer, 'check.ts'),
      ],
      { cwd: consumer, stdio: 'pipe' },
    );
    const session = await McpSession.start({
      executable: path.join(consumer, 'node_modules/.bin/jev-mcp'),
      cwd: consumer,
      launch: 'command',
      usePreload: false,
      env: { JEV_API_KEY: 'synthetic' },
    });
    try {
      await session.initialize();
      expect((await session.listTools()).tools.map((t) => t.name)).toEqual([
        'search_repo',
        'inspect_files',
      ]);
    } finally {
      session.endStdin();
      await session.waitForExit();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
