import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { listAllTools, resolveTool, type Upstreams } from "./upstreams.js";
import type { AgentContext } from "./auth.js";
import type { PolicyStore } from "./policy.js";
import { pinStatus } from "./pinning.js";
import { redactText, redactValue, mergeCounts, type RedactionCounts } from "./pii.js";
import { estimateTokens, toolCostAud, teamSpendToday } from "./cost.js";
import { recordCall } from "./audit.js";

const blocked = (reason: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: `⛔ AgentGate blocked this call: ${reason}` }],
});

/** Redact every text block (and structured output) in a tool result. */
function redactResult(result: CallToolResult): { result: CallToolResult; counts: RedactionCounts; text: string } {
  const all: RedactionCounts[] = [];
  let text = "";
  const content = (result.content ?? []).map((block) => {
    if (block.type !== "text") return block;
    const r = redactText(block.text);
    all.push(r.counts);
    text += r.text;
    return { ...block, text: r.text };
  });
  let structuredContent = result.structuredContent;
  if (structuredContent) {
    const r = redactValue(structuredContent);
    all.push(r.counts);
    structuredContent = r.value;
  }
  return { result: { ...result, content, structuredContent }, counts: mergeCounts(...all), text };
}

export function createGatewayServer(upstreams: Upstreams, agent: AgentContext, policies: PolicyStore) {
  const server = new Server({ name: "agentgate", version: "0.2.0" }, { capabilities: { tools: {} } });

  // Only approved (non-quarantined) tools are visible to agents
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listAllTools(upstreams).filter((t) => pinStatus.get(t.name) === "APPROVED"),
  }));

  // ── The security pipeline: every tool call goes through these checks ──
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const started = Date.now();
    const argsRedacted = redactValue(args ?? {}).value;
    const deny = async (reason: string) => {
      await recordCall({ agent, tool: name, argsRedacted, decision: "DENY", reason, latencyMs: Date.now() - started });
      console.log(`⛔ ${agent.name} (${agent.team.name}) → ${name}: ${reason}`);
      return blocked(reason);
    };

    // 1. Kill switch
    if (agent.paused) return deny("this agent is paused by an administrator");

    // 2. Budget
    const spent = await teamSpendToday(agent.team.id);
    if (spent >= agent.team.budgetAud) {
      return deny(`team "${agent.team.name}" has used its daily budget ($${agent.team.budgetAud.toFixed(2)} AUD)`);
    }

    // 3. Does the tool exist?
    const target = resolveTool(upstreams, name);
    if (!target) {
      await recordCall({ agent, tool: name, argsRedacted, decision: "ERROR", reason: "unknown tool", latencyMs: 0 });
      return blocked(`unknown tool ${name}`);
    }

    // 4. Authorisation (policy)
    const decision = policies.check(agent.team.name, name);
    if (!decision.allowed) return deny(decision.reason);

    // 5. Tool integrity (pinning)
    const pin = pinStatus.get(name);
    if (pin === "QUARANTINED") return deny("tool definition changed since it was approved (possible tampering)");
    if (pin !== "APPROVED") return deny("tool is pending admin approval");

    // 6. Forward to the real tool
    try {
      const raw = (await target.upstream.client.callTool({
        name: target.toolName,
        arguments: args ?? {},
      })) as CallToolResult;

      // 7. Redact sensitive data before it reaches the agent / LLM provider
      const { result, counts, text } = redactResult(raw);

      // 8. Cost estimate for the tokens this result adds to the agent's context
      const estTokens = estimateTokens(text);
      const latencyMs = Date.now() - started;

      // 9. Audit
      await recordCall({
        agent,
        tool: name,
        argsRedacted,
        decision: "ALLOW",
        reason: decision.reason,
        redactions: counts,
        latencyMs,
        estTokens,
        costAud: toolCostAud(estTokens),
      });
      const n = Object.values(counts).reduce((a, b) => a + (b ?? 0), 0);
      console.log(`✅ ${agent.name} (${agent.team.name}) → ${name}  ${latencyMs}ms${n ? `  🔒 ${n} redacted` : ""}`);
      return result;
    } catch (err) {
      await recordCall({
        agent,
        tool: name,
        argsRedacted,
        decision: "ERROR",
        reason: (err as Error).message,
        latencyMs: Date.now() - started,
      });
      return blocked(`upstream error calling ${name}`);
    }
  });

  return server;
}
