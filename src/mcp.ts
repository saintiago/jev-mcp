#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { jevRequestSchema, jevResultSchema } from './contracts.js';
import { createJevClient, JevError } from './index.js';
import type { JevClient } from './index.js';

const SERVER_NAME = 'jev-mcp';
const SERVER_VERSION = '0.0.0';
const TOOL_NAME = 'ask_jev';
const UNEXPECTED_FAILURE =
  'The evaluation failed unexpectedly. No request details were reported.';
const TOOL_DESCRIPTION = [
  'Ask TypeSafe JEv for structured judgments about supplied evidence.',
  'The tool sends the state and questions to the TypeSafe JEv API and does not modify local files.',
  'Ask narrow questions with explicit alternatives, supply only relevant evidence and batch related questions that share one state.',
  'JEv provides judgments, not code or prose answers; use deterministic tools for arithmetic, counting and executable checks.',
  'Confidence describes the provider distribution and does not authorize bypassing required workflow steps.',
].join(' ');

class StartupError extends Error {}

function clientFromEnvironment(env: NodeJS.ProcessEnv): JevClient {
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
  try {
    return createJevClient({
      apiKey,
      ...(model !== undefined && { model }),
      ...(timeoutMs !== undefined && { timeoutMs }),
    });
  } catch {
    if (rawTimeout !== undefined) {
      throw new StartupError(
        'JEV_TIMEOUT_MS must be a positive whole number of milliseconds.',
      );
    }
    if (model !== undefined && model.length === 0) {
      throw new StartupError('JEV_MODEL must not be empty.');
    }
    throw new StartupError('The JEv client configuration is invalid.');
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

function createServer(client: JevClient): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Ask JEv',
      description: TOOL_DESCRIPTION,
      inputSchema: jevRequestSchema,
      outputSchema: jevResultSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (request, extra) => {
      try {
        const result = await client.evaluate(request, { signal: extra.signal });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof JevError) {
          return failureResult(error);
        }
        return {
          content: [{ type: 'text', text: UNEXPECTED_FAILURE }],
          isError: true,
        };
      }
    },
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
  const client = clientFromEnvironment(process.env);
  const server = createServer(client);
  await server.connect(new StdioServerTransport());
  installShutdown(server);
}

main().catch((error: unknown) => {
  const message =
    error instanceof StartupError ? error.message : 'startup failed.';
  process.stderr.write(`jev-mcp: ${message}\n`);
  process.exit(1);
});
