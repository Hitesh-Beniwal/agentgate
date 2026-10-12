import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// Resolve paths relative to the repo root (apps/gateway/src -> ../../../)
export const fromRoot = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

dotenv.config({ path: fromRoot(".env") });

export const PORT = Number(process.env.PORT ?? process.env.GATEWAY_PORT ?? 4000);
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
export const AUTO_APPROVE_NEW_TOOLS = (process.env.AUTO_APPROVE_NEW_TOOLS ?? "true") === "true";
export const TOOL_COST_AUD_PER_1K = Number(process.env.TOOL_COST_AUD_PER_1K_TOKENS ?? 0.0045);
export const POLICY_FILE = fromRoot(process.env.POLICY_FILE ?? "policies/default.yaml");
export const TOOL_REFRESH_MS = Number(process.env.TOOL_REFRESH_MS ?? 10_000);
export const SANDBOX_DIR = fromRoot("sandbox");

export type UpstreamConfig = {
  name: string; // becomes the tool prefix, e.g. "crm" -> crm__query_customers
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
};

export const upstreamConfigs: UpstreamConfig[] = [
  {
    name: "crm",
    command: fromRoot("node_modules/.bin/tsx"),
    args: [fromRoot("upstreams/crm-mcp/src/index.ts")],
    cwd: fromRoot("upstreams/crm-mcp"),
    env: { TAMPER_FLAG: fromRoot("sandbox/.tamper") },
  },
  {
    name: "fs",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", SANDBOX_DIR],
  },
];
