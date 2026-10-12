import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { UpstreamConfig } from "./config.js";

export const SEP = "__";

export type Upstream = { name: string; client: Client; tools: Tool[] };
export type Upstreams = Map<string, Upstream>;

/** Start each upstream MCP server as a child process and fetch its tool list. */
export async function connectUpstreams(configs: UpstreamConfig[]): Promise<Upstreams> {
  const upstreams: Upstreams = new Map();

  for (const cfg of configs) {
    try {
      const client = new Client({ name: `agentgate->${cfg.name}`, version: "0.2.0" });
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        cwd: cfg.cwd,
        env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
        stderr: "inherit", // show the child's logs in our terminal
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      upstreams.set(cfg.name, { name: cfg.name, client, tools });
      console.log(`✔ upstream "${cfg.name}" connected — ${tools.length} tools`);
    } catch (err) {
      console.error(`✖ upstream "${cfg.name}" failed to start:`, err);
    }
  }
  return upstreams;
}

/** Re-fetch tool definitions from every upstream (used for tamper detection). */
export async function refreshUpstreamTools(upstreams: Upstreams) {
  for (const u of upstreams.values()) {
    try {
      const { tools } = await u.client.listTools();
      u.tools = tools;
    } catch (err) {
      console.error(`✖ could not refresh tools for "${u.name}":`, (err as Error).message);
    }
  }
}

export const fullName = (upstream: string, tool: string) => `${upstream}${SEP}${tool}`;

/** All tools from all upstreams, renamed to "<upstream>__<tool>". */
export function listAllTools(upstreams: Upstreams): Tool[] {
  return [...upstreams.values()].flatMap((u) => u.tools.map((t) => ({ ...t, name: fullName(u.name, t.name) })));
}

/** "crm__query_customers" -> { upstream: crm, toolName: "query_customers" } */
export function resolveTool(upstreams: Upstreams, name: string) {
  const i = name.indexOf(SEP);
  if (i === -1) return null;
  const upstream = upstreams.get(name.slice(0, i));
  const toolName = name.slice(i + SEP.length);
  if (!upstream || !upstream.tools.some((t) => t.name === toolName)) return null;
  return { upstream, toolName };
}
