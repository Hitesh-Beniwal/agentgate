import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { evaluate, parsePolicies, globToRegex } from "../src/policy.js";

const rules = parsePolicies(fs.readFileSync(new URL("../../../policies/default.yaml", import.meta.url), "utf8"));

test("glob matching", () => {
  assert.ok(globToRegex("crm__query_*").test("crm__query_customers"));
  assert.ok(!globToRegex("crm__query_*").test("crm__delete_customer"));
});

test("marketing can query customers", () => {
  assert.equal(evaluate(rules, "marketing", "crm__query_customers").allowed, true);
});

test("marketing cannot see salaries (default deny)", () => {
  const d = evaluate(rules, "marketing", "crm__query_salaries");
  assert.equal(d.allowed, false);
  assert.equal(d.ruleId, null);
});

test("hr can see salaries", () => {
  assert.equal(evaluate(rules, "hr", "crm__query_salaries").allowed, true);
});

test("deny beats allow: nobody can delete", () => {
  for (const team of ["marketing", "sales", "hr"]) {
    const d = evaluate(rules, team, "crm__delete_customer");
    assert.equal(d.allowed, false);
    assert.equal(d.ruleId, "block-destructive");
  }
});

test("everyone can read company files but not write them", () => {
  assert.equal(evaluate(rules, "sales", "fs__read_text_file").allowed, true);
  assert.equal(evaluate(rules, "sales", "fs__write_file").allowed, false);
});
