#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { jevResultSchema, jevToolRequestSchema } from './contracts.js';
import { createJevClient, JevError } from './index.js';
import type { JevClient, JevUsageLogOptions } from './index.js';

const SERVER_NAME = 'jev-mcp';
const SERVER_VERSION = '0.0.0';
const TOOL_NAME = 'ask_jev';
const UNEXPECTED_FAILURE =
  'The evaluation failed unexpectedly. No request details were reported.';
const TOOL_DESCRIPTION = [
  'Ask TypeSafe JEv for structured judgments about supplied evidence.',
  'The tool sends the state and questions to the TypeSafe JEv API and, when the host enables usage logging, appends one local JSONL usage record per evaluation; otherwise it writes no local files.',
  'Ask narrow questions with explicit alternatives, supply only relevant evidence and batch related questions that share one state.',
  'JEv provides judgments, not code or prose answers; use deterministic tools for arithmetic, counting and executable checks.',
  'Confidence describes the provider distribution and does not authorize bypassing required workflow steps.',
].join(' ');

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
      loggingEnabled: usageLog !== undefined,
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
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Ask JEv',
      description: TOOL_DESCRIPTION,
      inputSchema: jevToolRequestSchema,
      outputSchema: jevResultSchema,
      annotations: { readOnlyHint: !loggingEnabled, openWorldHint: true },
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
