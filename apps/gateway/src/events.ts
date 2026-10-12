import { EventEmitter } from "node:events";
import type { Request, Response } from "express";

export type GatewayEvent =
  | { type: "call"; call: Record<string, unknown> }
  | { type: "alert"; alert: Record<string, unknown> }
  | { type: "tools" }
  | { type: "agents" };

const bus = new EventEmitter();
bus.setMaxListeners(100);

export const emit = (e: GatewayEvent) => bus.emit("event", e);

/** Server-Sent Events: the dashboard keeps this connection open and gets pushed every event. */
export function sseHandler(req: Request, res: Response) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(`event: hello\ndata: {}\n\n`);

  const send = (e: GatewayEvent) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);

  bus.on("event", send);
  req.on("close", () => {
    clearInterval(ping);
    bus.off("event", send);
  });
}
