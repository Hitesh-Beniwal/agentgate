import fs from "node:fs";
import YAML from "yaml";

export type PolicyRule = {
  id: string;
  description?: string;
  teams: string[]; // team names, or "*" for everyone
  tools: string[]; // glob patterns, e.g. "crm__query_*"
  effect: "allow" | "deny";
};

export type Decision = { allowed: boolean; ruleId: string | null; reason: string };

/** "crm__query_*" -> /^crm__query_.*$/ */
export function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const matches = (patterns: string[], value: string) => patterns.some((p) => globToRegex(p).test(value));

/** Pure function: easy to unit test. Deny wins; no allow = deny. */
export function evaluate(rules: PolicyRule[], team: string, tool: string): Decision {
  const applicable = rules.filter((r) => matches(r.teams, team) && matches(r.tools, tool));
  const deny = applicable.find((r) => r.effect === "deny");
  if (deny) return { allowed: false, ruleId: deny.id, reason: `Denied by policy "${deny.id}"` };
  const allow = applicable.find((r) => r.effect === "allow");
  if (allow) return { allowed: true, ruleId: allow.id, reason: `Allowed by policy "${allow.id}"` };
  return { allowed: false, ruleId: null, reason: `No policy allows team "${team}" to use ${tool} (default deny)` };
}

export function parsePolicies(source: string): PolicyRule[] {
  const doc = YAML.parse(source) as { policies?: PolicyRule[] };
  const rules = doc?.policies ?? [];
  for (const r of rules) {
    if (!r.id || !Array.isArray(r.teams) || !Array.isArray(r.tools) || !["allow", "deny"].includes(r.effect)) {
      throw new Error(`Invalid policy rule: ${JSON.stringify(r)}`);
    }
  }
  return rules;
}

/** Loads the YAML file and hot-reloads it when it changes. */
export class PolicyStore {
  rules: PolicyRule[] = [];
  raw = "";
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.load();
    fs.watchFile(this.file, { interval: 1000 }, () => this.load());
  }

  private load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      this.rules = parsePolicies(raw);
      this.raw = raw;
      console.log(`✔ loaded ${this.rules.length} policies from ${this.file}`);
    } catch (err) {
      // Keep the previous good rules if the new file is broken
      console.error(`✖ policy file invalid, keeping previous rules:`, (err as Error).message);
    }
  }

  check(team: string, tool: string) {
    return evaluate(this.rules, team, tool);
  }
}
