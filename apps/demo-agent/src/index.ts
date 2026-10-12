/**
 * Demo AI agent: Gemini + MCP tools, connected THROUGH AgentGate.
 *
 *   npm run agent -- --as marketing "How many customers are in VIC?"
 *   npm run agent -- --as marketing "What is the CEO's salary?"
 *   npm run agent -- --as hr --json "List salaries"
 */
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

// ── CLI args ──
const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const json = argv.includes("--json");
if (json) argv.splice(argv.indexOf("--json"), 1);
const team = flag("--as") ?? "marketing";
const prompt = argv.join(" ").trim();

const DEV_KEYS: Record<string, string> = {
  marketing: "ag_dev_marketing_123",
  sales: "ag_dev_sales_456",
  hr: "ag_dev_hr_789",
  intruder: "ag_not_a_real_key",
};
const apiKey = process.env.AGENT_KEY ?? DEV_KEYS[team];
const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:4000";
// Comma-separated fallback list: first model is preferred, others are used if it is overloaded
const models = (process.env.GEMINI_MODEL ?? "gemini-3.5-flash,gemini-3.7-flash,gemini-flash-latest")
  .split(",").map((m) => m.trim()).filter(Boolean);
let model = models[0];

if (!prompt) {
  console.error('Usage: npm run agent -- --as <marketing|sales|hr|intruder> [--json] "your question"');
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing. Get a free key at https://aistudio.google.com/apikey and add it to .env");
  process.exit(1);
}

const log = (...a: unknown[]) => { if (!json) console.log(...a); };

// ── Connect to AgentGate (NOT directly to the tools) ──
const mcp = new Client({ name: `demo-agent-${team}`, version: "0.1.0" });
try {
  await mcp.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", gatewayUrl), {
      requestInit: { headers: { Authorization: `Bearer ${apiKey}` } },
    })
  );
} catch (err) {
  const msg = `Could not connect to AgentGate as "${team}": ${(err as Error).message}`;
  if (json) console.log(JSON.stringify({ team, prompt, error: msg, answer: "", toolCalls: [] }));
  else console.error("⛔ " + msg);
  process.exit(json ? 0 : 1);
}

const { tools } = await mcp.listTools();
// Keep the tool list small and model-friendly
const usable = tools.filter((t) => t.name.startsWith("crm__") || ["fs__read_text_file", "fs__list_directory"].includes(t.name));

const cleanSchema = (s: Record<string, unknown>) => {
  const { $schema, ...rest } = s;
  return rest;
};
const functionDeclarations: FunctionDeclaration[] = usable.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  parametersJsonSchema: cleanSchema(t.inputSchema as Record<string, unknown>),
}));

const systemInstruction =
  `You are an internal assistant for the ${team} team at Acme Pty Ltd. ` +
  `Use the available tools to answer. If a tool call is blocked by AgentGate, tell the user it was blocked and why — ` +
  `do not try to work around the block. Never invent data.`;

// 25s limit per model call: a slow model fails over to the next one instead of hanging
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 25_000 } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isTransient = (err: unknown) => /\b(429|500|503|504)\b|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|timed? ?out|aborted/i.test(String((err as Error)?.message ?? err));

/** Retry overloaded/rate-limited calls with backoff, then fall back to the next model. */
async function generateWithRetry(contents: Content[]) {
  let lastErr: unknown;
  for (const m of models) {
    log(`   → asking ${m}…`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await ai.models.generateContent({
          model: m,
          contents,
          config: { systemInstruction, tools: [{ functionDeclarations }] },
        });
        if (m !== model) log(`   (switched to fallback model ${m})`);
        model = m;
        return res;
      } catch (err) {
        lastErr = err;
        const msg = String((err as Error)?.message ?? err);
        if (/timed? ?out|aborted/i.test(msg)) {
          log(`   ⏱️  ${m} too slow (>25s), trying next model…`);
          break;
        }
        if (!isTransient(err)) {
          log(`   ⚠️  ${m} unavailable: ${msg.slice(0, 100)}`);
          break; // e.g. 404 model not found -> try next model
        }
        const wait = 1500 * 2 ** (attempt - 1);
        log(`   ⏳ ${m} busy (attempt ${attempt}/3), retrying in ${wait / 1000}s…`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

const contents: Content[] = [{ role: "user", parts: [{ text: prompt }] }];
const toolCalls: { name: string; args: unknown; blocked: boolean; output: string }[] = [];
let inputTokens = 0;
let outputTokens = 0;
let answer = "";

log(`\n🤖 ${team} agent → "${prompt}"   (models: ${models.join(" → ")}, ${functionDeclarations.length} tools)\n`);

for (let step = 0; step < 6; step++) {
  let res;
  try {
    res = await generateWithRetry(contents);
  } catch (err) {
    const msg = `Gemini API error (tried ${models.join(", ")}): ${(err as Error).message}`;
    if (json) console.log(JSON.stringify({ team, prompt, error: msg, answer: "", toolCalls }));
    else console.error(`\n❌ ${msg}\n   Tip: run the model list command and set GEMINI_MODEL in .env.`);
    await mcp.close();
    process.exit(json ? 0 : 1);
  }
  inputTokens += res.usageMetadata?.promptTokenCount ?? 0;
  outputTokens += (res.usageMetadata?.candidatesTokenCount ?? 0) + (res.usageMetadata?.thoughtsTokenCount ?? 0);

  const calls = res.functionCalls ?? [];
  if (!calls.length) {
    answer = res.text ?? "";
    break;
  }

  contents.push(res.candidates![0].content!);
  const parts: Part[] = [];
  for (const fc of calls) {
    const name = fc.name!;
    const result = await mcp.callTool({ name, arguments: (fc.args ?? {}) as Record<string, unknown> });
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
      .join("\n");
    const blocked = Boolean(result.isError);
    toolCalls.push({ name, args: fc.args ?? {}, blocked, output: text.slice(0, 500) });
    log(`${blocked ? "⛔" : "🔧"} ${name}(${JSON.stringify(fc.args ?? {})})`);
    log(`   ${text.replace(/\s+/g, " ").slice(0, 160)}${text.length > 160 ? "…" : ""}`);
    parts.push({ functionResponse: { id: fc.id, name, response: { result: text } } });
  }
  contents.push({ role: "user", parts });
}

// ── Report LLM usage so AgentGate can attribute cost to this team ──
await fetch(new URL("/api/usage", gatewayUrl), {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({ model, inputTokens, outputTokens }),
}).catch(() => {});

if (json) {
  console.log(JSON.stringify({ team, prompt, answer, toolCalls, usage: { inputTokens, outputTokens } }));
} else {
  console.log(`\n💬 ${answer}\n`);
  console.log(`(tokens: ${inputTokens} in / ${outputTokens} out)`);
}
await mcp.close();
