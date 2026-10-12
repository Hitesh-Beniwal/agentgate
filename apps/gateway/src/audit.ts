import { prisma, Prisma } from "@agentgate/db";
import { emit } from "./events.js";
import type { AgentContext } from "./auth.js";
import type { RedactionCounts } from "./pii.js";

export type AuditEntry = {
  agent: AgentContext;
  tool: string;
  argsRedacted: unknown;
  decision: "ALLOW" | "DENY" | "ERROR";
  reason?: string;
  redactions?: RedactionCounts;
  latencyMs: number;
  estTokens?: number;
  costAud?: number;
};

/** Every call — allowed, denied or failed — is written to Postgres and pushed to the dashboard. */
export async function recordCall(e: AuditEntry) {
  try {
    const row = await prisma.toolCall.create({
      data: {
        agentId: e.agent.id,
        tool: e.tool,
        argsRedacted: (e.argsRedacted ?? {}) as Prisma.InputJsonValue,
        decision: e.decision,
        reason: e.reason,
        redactions: (e.redactions ?? {}) as Prisma.InputJsonValue,
        latencyMs: e.latencyMs,
        estTokens: e.estTokens ?? 0,
        costAud: e.costAud ?? 0,
      },
    });
    emit({
      type: "call",
      call: {
        ...row,
        costAud: Number(row.costAud),
        agent: { name: e.agent.name, team: { name: e.agent.team.name } },
      },
    });
  } catch (err) {
    console.error("✖ failed to write audit log:", err);
  }
}
