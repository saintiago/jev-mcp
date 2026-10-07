import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { batchRequest, batchResponse } from './fixtures.js';
import {
  McpSession,
  readJsonBody,
  textContent,
  type McpSessionOptions,
} from './mcp-stdio-support.js';
import { startLoopbackServer, stopLoopbackServer } from './support.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE_DIR = fileURLToPath(
  new URL('./packed-consumer', import.meta.url),
);
const PRELOAD_SOURCE = fileURLToPath(
  new URL('./mcp-preload.mjs', import.meta.url),
);
const TSC_BIN = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
const SYNTHETIC_KEY = 'synthetic-packed-consumer-key';

interface CommandOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

interface ConsumerOutput {
  packageUrl: string;
  result: unknown;
  rejection: { code: string; status: number | null } | null;
  error: {
    name: string;
    isError: boolean;
    code: string;
    status: number | null;
    message: string;
  };
}

function run(
  command: string,
  args: string[],
  options: CommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env ?? process.env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(
            new Error(
              `"${command} ${args.join(' ')}" failed: ${error.message}\n${stdout}\n${stderr}`,
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function npmCommand(): { command: string; args: string[] } {
  const execPath = process.env.npm_execpath;
  if (execPath !== undefined && execPath.endsWith('.js')) {
    return { command: process.execPath, args: [execPath] };
  }
  return { command: 'npm', args: [] };
}

function consumerEnv(providerOrigin: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    JEV_API_KEY: SYNTHETIC_KEY,
    JEV_TEST_PROVIDER_ORIGIN: providerOrigin,
  };
}

function npmEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NODE_OPTIONS: undefined };
}

const sessions: McpSession[] = [];
const servers: Server[] = [];

async function startSession(options: McpSessionOptions): Promise<McpSession> {
  const session = await McpSession.start(options);
  sessions.push(session);
  return session;
}

let workDir: string | undefined;
let consumerDir: string;
let installedCommand: string;
let preloadPath: string;

beforeAll(async () => {
  for (const built of ['index.js', 'mcp.js']) {
    if (!existsSync(join(REPO_ROOT, 'dist', built))) {
      throw new Error(
        `dist/${built} is missing; run "npm run build" before the packed-consumer check`,
      );
    }
  }

  workDir = await mkdtemp(join(tmpdir(), 'jev-packed-consumer-'));
  const packDir = join(workDir, 'pack');
  await mkdir(packDir);
  const npm = npmCommand();
  await run(npm.command, [...npm.args, 'pack', '--pack-destination', packDir], {
    cwd: REPO_ROOT,
    env: npmEnv(),
  });
  const tarballs = (await readdir(packDir)).filter((name) =>
    name.endsWith('.tgz'),
  );
  expect(tarballs).toHaveLength(1);

  consumerDir = join(workDir, 'consumer');
  await mkdir(consumerDir);
  await writeFile(
    join(consumerDir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'jev-packed-consumer',
        version: '0.0.0',
        private: true,
        type: 'module',
      },
      null,
      2,
    )}\n`,
  );
  await run(
    npm.command,
    [
      ...npm.args,
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--prefer-offline',
      join(packDir, tarballs[0] ?? ''),
    ],
    { cwd: consumerDir, env: npmEnv() },
  );

  const packageDir = join(consumerDir, 'node_modules', '@saintiago', 'jev');
  expect(existsSync(join(packageDir, 'dist', 'index.d.ts'))).toBe(true);
  expect(existsSync(join(packageDir, 'src'))).toBe(false);
  const manifest = JSON.parse(
    await readFile(join(packageDir, 'package.json'), 'utf8'),
  ) as { bin?: Record<string, string> };
  const binEntry = manifest.bin?.['jev-mcp'];
  if (binEntry === undefined) {
    throw new Error('the packed package does not declare the jev-mcp bin');
  }
  const installedExecutable = join(packageDir, binEntry);
  expect(existsSync(installedExecutable)).toBe(true);
  installedCommand = join(consumerDir, 'node_modules', '.bin', 'jev-mcp');
  expect(existsSync(installedCommand)).toBe(true);

  preloadPath = join(consumerDir, 'provider-preload.mjs');
  await cp(PRELOAD_SOURCE, preloadPath);
  for (const fixture of [
    'consumer-api.mjs',
    'check-types.ts',
    'tsconfig.json',
  ]) {
    await cp(join(FIXTURE_DIR, fixture), join(consumerDir, fixture));
  }
}, 180_000);

afterAll(async () => {
  while (sessions.length > 0) {
    sessions.pop()?.kill();
  }
  while (servers.length > 0) {
    const server = servers.pop();
    if (server !== undefined) {
      await stopLoopbackServer(server);
    }
  }
  if (workDir !== undefined) {
    await rm(workDir, { recursive: true, force: true });
  }
});

describe('packed consumer', () => {
  it('type-checks the installed root declarations in a clean consumer', async () => {
    const stdout = await run(
      process.execPath,
      [TSC_BIN, '-p', join(consumerDir, 'tsconfig.json')],
      { cwd: consumerDir },
    );
    expect(stdout).toBe('');
  }, 120_000);

  it('evaluates a three-mode batch and reports errors without the source checkout', async () => {
    const requests: unknown[] = [];
    const { server, origin } = await startLoopbackServer(
      async (request, response) => {
        requests.push(await readJsonBody(request));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(batchResponse));
      },
    );
    servers.push(server);
    await writeFile(
      join(consumerDir, 'request.json'),
      `${JSON.stringify(batchRequest)}\n`,
    );

    const stdout = await run(
      process.execPath,
      ['--import', preloadPath, join(consumerDir, 'consumer-api.mjs')],
      { cwd: consumerDir, env: consumerEnv(origin) },
    );
    const output = JSON.parse(stdout) as ConsumerOutput;

    const resolved = fileURLToPath(output.packageUrl);
    expect(resolved.startsWith(`${consumerDir}/`)).toBe(true);
    expect(output.result).toEqual(batchResponse);
    expect(output.rejection).toEqual({ code: 'invalid_input', status: null });
    expect(output.error).toEqual({
      name: 'JevError',
      isError: true,
      code: 'invalid_input',
      status: 422,
      message: 'The request is invalid.',
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      state: batchRequest.state,
      model: 'jev-1.13.0',
      questions: batchRequest.questions,
    });
  }, 120_000);

  it('initializes and calls ask_jev through the installed command', async () => {
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
      launch: 'command',
      executable: installedCommand,
      preload: preloadPath,
      providerOrigin: origin,
      env: { JEV_API_KEY: SYNTHETIC_KEY },
    });
    const init = await session.initialize();
    expect(init.serverInfo.name).toBe('jev-mcp');

    const { tools } = await session.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['ask_jev']);

    const result = await session.callTool(batchRequest).response;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual(batchResponse);
    expect(JSON.parse(textContent(result))).toEqual(batchResponse);

    expect(requests).toHaveLength(1);
    expect((requests[0] as { model: string }).model).toBe('jev-1.13.0');
    expect(session.stdoutAsProtocolOnly()).toBe(true);
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
  }, 60_000);

  it('fails startup safely without a credential through the installed command', async () => {
    const session = await startSession({
      launch: 'command',
      executable: installedCommand,
      usePreload: false,
    });
    const exit = await session.waitForExit();
    expect(exit).toEqual({ code: 1, signal: null });
    expect(session.stderr).toContain('JEV_API_KEY');
    expect(session.stderr).not.toContain(SYNTHETIC_KEY);
    expect(session.stdoutLines).toEqual([]);
  }, 30_000);
});
