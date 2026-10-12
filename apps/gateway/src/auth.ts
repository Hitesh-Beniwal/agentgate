import { createHash } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma } from "@agentgate/db";
import { ADMIN_TOKEN } from "./config.js";

export type AgentContext = {
  id: string;
  name: string;
  paused: boolean;
  team: { id: string; name: string; budgetAud: number };
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const bearer = (req: Request) => {
  const h = req.header("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
};

/** Look up the agent by the hash of its API key. Keys are never stored in plain text. */
export async function authenticateAgent(req: Request): Promise<AgentContext | null> {
  const key = bearer(req);
  if (!key) return null;
  const agent = await prisma.agent.findUnique({
    where: { keyHash: sha256(key) },
    include: { team: true },
  });
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    paused: agent.paused,
    team: { id: agent.team.id, name: agent.team.name, budgetAud: Number(agent.team.budgetAud) },
  };
}

/** Protects the dashboard API when ADMIN_TOKEN is set (header or ?token= for SSE). */
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_TOKEN) return next();
  const token = req.header("x-admin-token") ?? (req.query.token as string | undefined);
  if (token === ADMIN_TOKEN) return next();
  res.status(401).json({ error: "admin token required" });
}
