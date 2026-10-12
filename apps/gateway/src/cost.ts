import { prisma } from "@agentgate/db";
import { TOOL_COST_AUD_PER_1K } from "./config.js";

/** Rough token estimate (~4 characters per token for English/JSON). */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export const toolCostAud = (tokens: number) => (tokens / 1000) * TOOL_COST_AUD_PER_1K;

export const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

/** Today's spend for a team = tool-result tokens + LLM usage reported by its agents. */
export async function teamSpendToday(teamId: string): Promise<number> {
  const since = startOfToday();
  const [calls, usage] = await Promise.all([
    prisma.toolCall.aggregate({ _sum: { costAud: true }, where: { createdAt: { gte: since }, agent: { teamId } } }),
    prisma.usageReport.aggregate({ _sum: { costAud: true }, where: { createdAt: { gte: since }, agent: { teamId } } }),
  ]);
  return Number(calls._sum.costAud ?? 0) + Number(usage._sum.costAud ?? 0);
}

/** Approximate public list prices (USD per 1M tokens) converted to AUD. Free tier = $0 billed, but we show list price. */
const PRICES_USD_PER_M: Record<string, { in: number; out: number }> = {
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
  "gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "gemini-2.5-pro": { in: 1.25, out: 10 },
};
const USD_TO_AUD = 1.5;

export function llmCostAud(model: string, inputTokens: number, outputTokens: number) {
  const p = PRICES_USD_PER_M[model] ?? { in: 1, out: 4 };
  return ((inputTokens * p.in + outputTokens * p.out) / 1_000_000) * USD_TO_AUD;
}
