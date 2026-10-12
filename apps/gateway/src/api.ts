import { Router } from "express";
import { prisma, Prisma } from "@agentgate/db";
import { authenticateAgent, requireAdmin } from "./auth.js";
import { sseHandler, emit } from "./events.js";
import { approvePin } from "./pinning.js";
import { llmCostAud, startOfToday } from "./cost.js";
import type { PolicyStore } from "./policy.js";

export function createApi(policies: PolicyStore) {
  const api = Router();

  // ── Agent-facing: agents report their own LLM token usage ──
  api.post("/usage", async (req, res) => {
    const agent = await authenticateAgent(req);
    if (!agent) return res.status(401).json({ error: "invalid API key" });
    const { model, inputTokens, outputTokens } = req.body ?? {};
    if (typeof model !== "string" || !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) {
      return res.status(400).json({ error: "model, inputTokens, outputTokens required" });
    }
    const row = await prisma.usageReport.create({
      data: { agentId: agent.id, model, inputTokens, outputTokens, costAud: llmCostAud(model, inputTokens, outputTokens) },
    });
    emit({ type: "agents" });
    res.json({ ok: true, costAud: Number(row.costAud) });
  });

  // ── Everything below is for the dashboard (admin) ──
  api.use(requireAdmin);

  api.get("/events", sseHandler);

  api.get("/stats", async (_req, res) => {
    const since = startOfToday();
    const [total, denied, calls, usage, openAlerts] = await Promise.all([
      prisma.toolCall.count({ where: { createdAt: { gte: since } } }),
      prisma.toolCall.count({ where: { createdAt: { gte: since }, decision: "DENY" } }),
      prisma.toolCall.findMany({ where: { createdAt: { gte: since } }, select: { redactions: true, costAud: true } }),
      prisma.usageReport.aggregate({ _sum: { costAud: true }, where: { createdAt: { gte: since } } }),
      prisma.alert.count({ where: { resolved: false } }),
    ]);
    const redacted = calls.reduce(
      (sum, c) => sum + Object.values((c.redactions ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0),
      0
    );
    const cost = calls.reduce((s, c) => s + Number(c.costAud), 0) + Number(usage._sum.costAud ?? 0);
    res.json({ total, denied, redacted, costAud: cost, openAlerts });
  });

  api.get("/calls", async (req, res) => {
    const { agent, team, tool, decision } = req.query as Record<string, string | undefined>;
    const where: Prisma.ToolCallWhereInput = {};
    if (tool) where.tool = { contains: tool };
    if (decision) where.decision = decision as "ALLOW" | "DENY" | "ERROR";
    if (agent || team) {
      where.agent = {
        ...(agent ? { name: { contains: agent } } : {}),
        ...(team ? { team: { name: team } } : {}),
      };
    }
    const rows = await prisma.toolCall.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(Number(req.query.limit ?? 100), 500),
      include: { agent: { select: { name: true, team: { select: { name: true } } } } },
    });
    res.json(rows.map((r) => ({ ...r, costAud: Number(r.costAud) })));
  });

  api.get("/tools", async (_req, res) => {
    const pins = await prisma.toolPin.findMany({ orderBy: [{ upstream: "asc" }, { toolName: "asc" }] });
    res.json(pins);
  });

  api.post("/tools/:id/approve", async (req, res) => {
    res.json(await approvePin(req.params.id));
  });

  api.get("/alerts", async (_req, res) => {
    res.json(await prisma.alert.findMany({ orderBy: { createdAt: "desc" }, take: 50 }));
  });

  api.get("/policies", (_req, res) => {
    res.json({ rules: policies.rules, raw: policies.raw });
  });

  api.get("/agents", async (_req, res) => {
    const agents = await prisma.agent.findMany({ include: { team: true }, orderBy: { name: "asc" } });
    res.json(agents.map((a) => ({ id: a.id, name: a.name, paused: a.paused, team: a.team.name })));
  });

  // Kill switch: pause / resume an agent instantly
  api.post("/agents/:id/toggle", async (req, res) => {
    const a = await prisma.agent.findUniqueOrThrow({ where: { id: req.params.id } });
    const updated = await prisma.agent.update({ where: { id: a.id }, data: { paused: !a.paused } });
    emit({ type: "agents" });
    res.json({ id: updated.id, paused: updated.paused });
  });

  api.get("/costs", async (_req, res) => {
    const since = startOfToday();
    const teams = await prisma.team.findMany({ include: { agents: true } });
    const out = await Promise.all(
      teams.map(async (t) => {
        const ids = t.agents.map((a) => a.id);
        const [toolAgg, llmAgg, toolAll, llmAll] = await Promise.all([
          prisma.toolCall.aggregate({ _sum: { costAud: true }, where: { agentId: { in: ids }, createdAt: { gte: since } } }),
          prisma.usageReport.aggregate({ _sum: { costAud: true, inputTokens: true, outputTokens: true }, where: { agentId: { in: ids }, createdAt: { gte: since } } }),
          prisma.toolCall.aggregate({ _sum: { costAud: true }, where: { agentId: { in: ids } } }),
          prisma.usageReport.aggregate({ _sum: { costAud: true }, where: { agentId: { in: ids } } }),
        ]);
        const toolToday = Number(toolAgg._sum.costAud ?? 0);
        const llmToday = Number(llmAgg._sum.costAud ?? 0);
        return {
          team: t.name,
          budgetAud: Number(t.budgetAud),
          todayAud: toolToday + llmToday,
          toolTodayAud: toolToday,
          llmTodayAud: llmToday,
          llmTokensToday: (llmAgg._sum.inputTokens ?? 0) + (llmAgg._sum.outputTokens ?? 0),
          allTimeAud: Number(toolAll._sum.costAud ?? 0) + Number(llmAll._sum.costAud ?? 0),
        };
      })
    );
    res.json(out);
  });

  api.post("/evals", async (req, res) => {
    const { passed, failed, results, gitSha } = req.body ?? {};
    const row = await prisma.evalRun.create({
      data: { passed: Number(passed), failed: Number(failed), results: (results ?? []) as Prisma.InputJsonValue, gitSha },
    });
    res.json(row);
  });

  api.get("/evals", async (_req, res) => {
    res.json(await prisma.evalRun.findMany({ orderBy: { createdAt: "desc" }, take: 20 }));
  });

  return api;
}
