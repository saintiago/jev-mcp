#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  retrieveEvidenceSchema,
  expandEvidenceSchema,
} from './repository-contracts.js';
import { createRepositoryClient } from './repository.js';
import { createJevClient, JevError } from './index.js';
import type { JevClient, JevUsageLogOptions } from './index.js';

const SERVER_NAME = 'jev-mcp';
const SERVER_VERSION = '0.0.0';
const UNEXPECTED_FAILURE =
  'Repository inspection failed. No source or credential details were reported.';

class StartupError extends Error {}

function clientFromEnvironment(env: NodeJS.ProcessEnv): {
  client: JevClient;
  loggingEnabled: boolean;
} {
  const apiKey = env.JEV_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new StartupError('JEV_API_KEY is required.');
  }
  const model = env.JEV_MODEL;
  const rawTimeout = env.JEV_TIMEOUT_MS;
  let timeoutMs: number | undefined;
  if (rawTimeout !== undefined) {
    if (!/^\d+$/.test(rawTimeout)) {
      throw new StartupError(
        'JEV_TIMEOUT_MS must be a whole number of milliseconds.',
      );
    }
    timeoutMs = Number(rawTimeout);
  }
  const retrievalLogPath = env.JEV_RETRIEVAL_LOG_PATH;
  if (retrievalLogPath !== undefined && retrievalLogPath.trim() === '')
    throw new StartupError(
      'JEV_RETRIEVAL_LOG_PATH must name a nonempty file path.',
    );
  const usageLogPath = env.JEV_USAGE_LOG_PATH;
  const usageLogCaller = env.JEV_USAGE_LOG_CALLER;
  let usageLog: JevUsageLogOptions | undefined;
  if (usageLogPath !== undefined) {
    if (usageLogPath.length === 0) {
      throw new StartupError(
        'JEV_USAGE_LOG_PATH must name a nonempty file path.',
      );
    }
    usageLog = {
      path: usageLogPath,
      ...(usageLogCaller !== undefined && { caller: usageLogCaller }),
    };
  }
  try {
    return {
      client: createJevClient({
        apiKey,
        ...(model !== undefined && { model }),
        ...(timeoutMs !== undefined && { timeoutMs }),
        ...(usageLog !== undefined && { usageLog }),
      }),
      loggingEnabled: usageLog !== undefined || retrievalLogPath !== undefined,
    };
  } catch (error) {
    if (error instanceof JevError) {
      throw new StartupError('The JEv client configuration is invalid.');
    }
    throw error;
  }
}

function failureResult(error: JevError): CallToolResult {
  const status =
    error.status === undefined ? '' : ` (HTTP status ${error.status})`;
  return {
    content: [
      { type: 'text', text: `${error.code}: ${error.message}${status}` },
    ],
    isError: true,
  };
}

function createServer(client: JevClient, loggingEnabled: boolean): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const repository = createRepositoryClient(
    client,
    process.cwd(),
    process.env['JEV_RETRIEVAL_LOG_PATH'] === undefined
      ? undefined
      : {
          path: process.env['JEV_RETRIEVAL_LOG_PATH'],
          ...(process.env['JEV_USAGE_LOG_CALLER'] === undefined
            ? {}
            : { caller: process.env['JEV_USAGE_LOG_CALLER'] }),
        },
  );
  const annotations = { readOnlyHint: !loggingEnabled, openWorldHint: true };
  async function respond(
    operation: () => Promise<object>,
  ): Promise<CallToolResult> {
    try {
      const result = await operation();
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof JevError) return failureResult(error);
      return {
        content: [{ type: 'text', text: UNEXPECTED_FAILURE }],
        isError: true,
      };
    }
  }
  server.registerTool(
    'retrieve_evidence',
    {
      description:
        'Find and read evidence from multiple repository files in one call. Supply scope and a question, exact literal terms, or both. Uses rg first and JEv for conceptual/noisy discovery. Returns exact excerpts with paths, original start/end lines, source identity and explicit omissions. Batch expand_evidence for missing context. Scores never establish absence or correctness. Source may be sent to TypeSafe; optional logs contain metadata only.',
      inputSchema: retrieveEvidenceSchema,
      annotations,
    },
    (request, extra) =>
      respond(() =>
        repository.retrieveEvidence(request, { signal: extra.signal }),
      ),
  );
  server.registerTool(
    'expand_evidence',
    {
      description:
        'Read multiple exact source ranges or complete files in one call, without JEv filtering. Use full=true for complete source or start/end for surrounding evidence. Returns original text and line numbers, merging overlapping ranges. Ignored, binary and unavailable files remain explicit. No modifications or correctness judgments.',
      inputSchema: expandEvidenceSchema,
      annotations,
    },
    (request, extra) =>
      respond(() =>
        repository.expandEvidence(request, { signal: extra.signal }),
      ),
  );
  return server;
}

function installShutdown(server: McpServer): void {
  let closing: Promise<void> | undefined;
  const onStdinEnd = (): void => shutdown();
  const onSignal = (): void => shutdown();
  const removeListeners = (): void => {
    process.stdin.off('end', onStdinEnd);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  };
  const shutdown = (): void => {
    removeListeners();
    closing ??= server.close();
    void closing.catch(() => process.exit(1));
  };
  process.stdin.on('end', onStdinEnd);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

async function main(): Promise<void> {
  const { client, loggingEnabled } = clientFromEnvironment(process.env);
  const server = createServer(client, loggingEnabled);
  await server.connect(new StdioServerTransport());
  installShutdown(server);
}

main().catch((error: unknown) => {
  const message =
    error instanceof StartupError ? error.message : 'startup failed.';
  process.stderr.write(`jev-mcp: ${message}\n`);
  process.exit(1);
});
