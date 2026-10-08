import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';

export const MCP_EXECUTABLE = fileURLToPath(
  new URL('../dist/mcp.js', import.meta.url),
);
export const MCP_PRELOAD = fileURLToPath(
  new URL('./mcp-preload.mjs', import.meta.url),
);

export interface McpSessionOptions {
  providerOrigin?: string;
  cwd?: string;
  env?: Record<string, string>;
  usePreload?: boolean;
  /** Executable to launch; defaults to the built dist/mcp.js. */
  executable?: string;
  /** Preload module that routes provider calls; defaults to mcp-preload.mjs. */
  preload?: string;
  /**
   * Run the executable directly as a command, passing the preload through
   * NODE_OPTIONS, instead of running it with the current Node binary.
   */
  launch?: 'node' | 'command';
}

export interface McpExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface JsonSchema {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: unknown;
  oneOf?: JsonSchema[];
  [key: string]: unknown;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown };
}

export interface McpCallToolResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: unknown;
}

export class McpSession {
  readonly stdoutLines: string[] = [];
  stderr = '';
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private buffer = '';
  private exitInfo: McpExit | undefined;
  private readonly exitWaiters: Array<(exit: McpExit) => void> = [];

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => {
      this.exitInfo = { code, signal };
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
      }
      this.pending.clear();
      for (const waiter of this.exitWaiters.splice(0)) {
        waiter(this.exitInfo);
      }
    });
  }

  static async start(options: McpSessionOptions = {}): Promise<McpSession> {
    const executable = options.executable ?? MCP_EXECUTABLE;
    if (!existsSync(executable)) {
      throw new Error(`${executable} is missing; run "npm run build" first`);
    }
    const usePreload = options.usePreload !== false;
    const preload = options.preload ?? MCP_PRELOAD;
    let env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      ...(options.providerOrigin !== undefined && {
        JEV_TEST_PROVIDER_ORIGIN: options.providerOrigin,
      }),
      ...options.env,
    };
    let command = process.execPath;
    let args: string[];
    if (options.launch === 'command') {
      command = executable;
      args = [];
      if (usePreload) {
        env = { ...env, NODE_OPTIONS: `--import ${preload}` };
      }
    } else {
      args = [...(usePreload ? ['--import', preload] : []), executable];
    }
    const child = spawn(command, args, {
      env,
      ...(options.cwd && { cwd: options.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    return new McpSession(child);
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    this.stdoutLines.push(line);
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (typeof message.id !== 'number') {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error !== undefined) {
      pending.reject(
        new Error(`MCP error ${message.error.code}: ${message.error.message}`),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  send(
    method: string,
    params?: unknown,
    timeoutMs = 5000,
  ): { id: number; response: Promise<unknown> } {
    const id = this.nextId;
    this.nextId += 1;
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({ jsonrpc: '2.0', id, method, params });
    return { id, response };
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(message: JsonRpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  async initialize(): Promise<{
    serverInfo: { name: string; version: string };
  }> {
    const result = (await this.send('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'jev-stdio-test', version: '0.0.0' },
    }).response) as { serverInfo: { name: string; version: string } };
    this.notify('notifications/initialized', {});
    return result;
  }

  async listTools(): Promise<{ tools: McpToolDefinition[] }> {
    return (await this.send('tools/list', {}).response) as {
      tools: McpToolDefinition[];
    };
  }

  callTool(
    args: unknown,
    timeoutMs = 5000,
    name = 'inspect_files',
  ): { id: number; response: Promise<McpCallToolResult> } {
    return this.send('tools/call', { name, arguments: args }, timeoutMs) as {
      id: number;
      response: Promise<McpCallToolResult>;
    };
  }

  cancel(id: number, reason: string): void {
    this.notify('notifications/cancelled', { requestId: id, reason });
  }

  endStdin(): void {
    this.child.stdin.end();
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): void {
    this.child.kill(signal);
  }

  get exited(): McpExit | undefined {
    return this.exitInfo;
  }

  async waitForExit(timeoutMs = 5000): Promise<McpExit> {
    if (this.exitInfo !== undefined) {
      return this.exitInfo;
    }
    return await new Promise<McpExit>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('timed out waiting for the process to exit'));
      }, timeoutMs);
      this.exitWaiters.push((exit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
  }

  stdoutAsProtocolOnly(): boolean {
    return this.stdoutLines.every((line) => {
      try {
        const message = JSON.parse(line) as JsonRpcMessage;
        return message.jsonrpc === '2.0';
      } catch {
        return false;
      }
    });
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    request.on('end', resolve);
    request.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export function textContent(result: McpCallToolResult): string {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('\n');
}
