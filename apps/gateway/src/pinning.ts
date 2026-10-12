import { createHash } from "node:crypto";
import { prisma, Prisma } from "@agentgate/db";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { AUTO_APPROVE_NEW_TOOLS } from "./config.js";
import { emit } from "./events.js";
import { fullName, type Upstreams } from "./upstreams.js";

export type PinStatus = "PENDING" | "APPROVED" | "QUARANTINED";

/** JSON with sorted keys, so the same definition always gives the same hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fingerprint of everything the model reads about a tool. */
export const hashTool = (t: Tool) =>
  createHash("sha256")
    .update(canonicalJson({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema }))
    .digest("hex");

/** In-memory view of pin status, keyed by full tool name ("crm__query_customers"). */
export const pinStatus = new Map<string, PinStatus>();

/**
 * Compare every upstream tool with its approved fingerprint.
 * - new tool      -> APPROVED (if AUTO_APPROVE_NEW_TOOLS) or PENDING
 * - same hash     -> unchanged
 * - changed hash  -> QUARANTINED + alert   (possible "rug pull")
 */
export async function syncPins(upstreams: Upstreams) {
  let changed = false;

  for (const u of upstreams.values()) {
    for (const tool of u.tools) {
      const name = fullName(u.name, tool.name);
      const hash = hashTool(tool);
      const definition = JSON.parse(JSON.stringify(tool)) as Prisma.InputJsonValue;
      const existing = await prisma.toolPin.findUnique({
        where: { upstream_toolName: { upstream: u.name, toolName: tool.name } },
      });

      if (!existing) {
        const status: PinStatus = AUTO_APPROVE_NEW_TOOLS ? "APPROVED" : "PENDING";
        await prisma.toolPin.create({
          data: {
            upstream: u.name,
            toolName: tool.name,
            currentHash: hash,
            approvedHash: status === "APPROVED" ? hash : null,
            definition,
            status,
          },
        });
        pinStatus.set(name, status);
        changed = true;
        continue;
      }

      if (existing.approvedHash && existing.approvedHash !== hash) {
        if (existing.status !== "QUARANTINED" || existing.currentHash !== hash) {
          await prisma.toolPin.update({
            where: { id: existing.id },
            data: { status: "QUARANTINED", currentHash: hash, definition },
          });
          const alert = await prisma.alert.create({
            data: {
              kind: "TOOL_TAMPERED",
              message: `Tool definition for ${name} changed since approval — quarantined`,
              data: { tool: name, approvedHash: existing.approvedHash, newHash: hash } as Prisma.InputJsonValue,
            },
          });
          console.warn(`🚨 ${alert.message}`);
          emit({ type: "alert", alert });
          changed = true;
        }
        pinStatus.set(name, "QUARANTINED");
        continue;
      }

      // Definition matches the approved fingerprint again (e.g. tampering reverted)
      const status: PinStatus = existing.approvedHash === hash ? "APPROVED" : (existing.status as PinStatus);
      if (existing.currentHash !== hash || existing.status !== status) {
        await prisma.toolPin.update({ where: { id: existing.id }, data: { currentHash: hash, definition, status } });
        if (existing.status === "QUARANTINED" && status === "APPROVED") {
          // Tampering was reverted: close the related alerts
          await prisma.alert.updateMany({
            where: { kind: "TOOL_TAMPERED", resolved: false, message: { contains: name } },
            data: { resolved: true },
          });
          console.log(`✔ ${name} restored to its approved definition — alerts resolved`);
        }
        changed = true;
      }
      pinStatus.set(name, status);
    }
  }

  if (changed) emit({ type: "tools" });
}

/** Admin approves the current definition: it becomes the new trusted fingerprint. */
export async function approvePin(id: string) {
  const pin = await prisma.toolPin.findUniqueOrThrow({ where: { id } });
  const updated = await prisma.toolPin.update({
    where: { id },
    data: { status: "APPROVED", approvedHash: pin.currentHash },
  });
  await prisma.alert.updateMany({
    where: { kind: "TOOL_TAMPERED", resolved: false, message: { contains: fullName(pin.upstream, pin.toolName) } },
    data: { resolved: true },
  });
  pinStatus.set(fullName(pin.upstream, pin.toolName), "APPROVED");
  emit({ type: "tools" });
  return updated;
}
