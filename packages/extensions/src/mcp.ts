import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@redgiant/agent";

export type McpTransportConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers?: Record<string, string> };

export interface McpServerConfig {
  name: string;
  transport: McpTransportConfig;
}

const toolName = (server: string, tool: string) =>
  `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);

/**
 * One MCP server, connected lazily; its tools become agent tools named
 * `mcp__<server>__<tool>`. Only the user configures servers: a stdio server runs as a
 * process of the RedGiant server, an http one is reached over the network.
 */
export class McpConnection {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;

  constructor(
    readonly config: McpServerConfig,
    /** For tests: a ready transport instead of the configured one. */
    private readonly transport?: () => Transport,
  ) {}

  private connect(): Promise<Client> {
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= (async () => {
      const c = new Client({ name: "redgiant", version: "2" });
      const t =
        this.transport?.() ??
        (this.config.transport.type === "stdio"
          ? new StdioClientTransport({
              command: this.config.transport.command,
              args: this.config.transport.args ?? [],
              ...(this.config.transport.env && { env: this.config.transport.env }),
              ...(this.config.transport.cwd && { cwd: this.config.transport.cwd }),
              stderr: "ignore",
            })
          : new StreamableHTTPClientTransport(new URL(this.config.transport.url), {
              requestInit: { headers: this.config.transport.headers ?? {} },
            }));
      await c.connect(t);
      this.client = c;
      return c;
    })();
    this.connecting.catch(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async tools(): Promise<Tool[]> {
    const client = await this.connect();
    const { tools } = await client.listTools();
    return tools
      .map(
        (t): Tool => ({
          def: {
            name: toolName(this.config.name, t.name),
            description: `[MCP ${this.config.name}] ${t.description ?? t.name}`,
            inputSchema: t.inputSchema as Record<string, unknown>,
          },
          run: async (input, ctx) => {
            const r = await client.callTool(
              { name: t.name, arguments: (input ?? {}) as Record<string, unknown> },
              undefined,
              {
                ...(ctx.signal && { signal: ctx.signal }),
                timeout: 300_000,
              },
            );
            const content =
              (r.content as
                | { type: string; text?: string; resource?: { uri?: string; text?: string } }[]
                | undefined) ?? [];
            const text = content
              .map((c) =>
                c.type === "text"
                  ? (c.text ?? "")
                  : c.type === "resource"
                    ? (c.resource?.text ?? `[resource ${c.resource?.uri}]`)
                    : `[${c.type}]`,
              )
              .join("\n");
            return {
              content: text || JSON.stringify(r.structuredContent ?? {}),
              isError: Boolean(r.isError),
            };
          },
        }),
      )
      .sort((a, b) => (a.def.name < b.def.name ? -1 : 1));
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => {});
    this.client = undefined;
    this.connecting = undefined;
  }
}
