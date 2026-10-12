import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { PORT, POLICY_FILE, TOOL_REFRESH_MS, upstreamConfigs } from "./config.js";
import { connectUpstreams, refreshUpstreamTools } from "./upstreams.js";
import { createGatewayServer } from "./mcpServer.js";
import { authenticateAgent } from "./auth.js";
import { PolicyStore } from "./policy.js";
import { syncPins } from "./pinning.js";
import { createApi } from "./api.js";

const policies = new PolicyStore(POLICY_FILE);
const upstreams = await connectUpstreams(upstreamConfigs);
await syncPins(upstreams);

// Tamper detection: re-check every tool definition on a timer
setInterval(async () => {
  await refreshUpstreamTools(upstreams);
  await syncPins(upstreams).catch((e) => console.error("pin sync failed:", e));
}, TOOL_REFRESH_MS);

const app = express();
app.use(express.json({ limit: "1mb" }));

// ── MCP endpoint for agents ──
app.post("/mcp", async (req: Request, res: Response) => {
  // Authenticate BEFORE anything else: no valid key, no tools
  const agent = await authenticateAgent(req);
  if (!agent) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized: missing or invalid AgentGate API key" },
      id: null,
    });
    return;
  }

  // Stateless mode: fresh server + transport per request (scales horizontally)
  const server = createGatewayServer(upstreams, agent, policies);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

const notAllowed = (_req: Request, res: Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

// ── Dashboard API + static dashboard ──
app.use("/api", createApi(policies));
app.get("/health", (_req, res) => res.json({ ok: true, upstreams: [...upstreams.keys()] }));
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));

app.listen(PORT, () => {
  console.log(`\n🛡️  AgentGate MCP endpoint:  http://localhost:${PORT}/mcp`);
  console.log(`📊 Dashboard:              http://localhost:${PORT}\n`);
});

// Never let one failed request crash the whole gateway
process.on("unhandledRejection", (err) => console.error("Unhandled error:", err));

process.on("SIGINT", async () => {
  for (const u of upstreams.values()) await u.client.close();
  process.exit(0);
});
