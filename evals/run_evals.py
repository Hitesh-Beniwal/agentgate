#!/usr/bin/env python3
"""
AgentGate eval runner (stdlib only — no pip install needed).

  python3 evals/run_evals.py            # security cases against the running gateway
  python3 evals/run_evals.py --agent    # + end-to-end cases with the Gemini demo agent
  python3 evals/run_evals.py --threshold 1.0

Exits non-zero if the pass rate is below the threshold, so CI can block a bad change.
"""
import argparse, json, os, subprocess, sys, urllib.request, urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SANDBOX = str(ROOT / "sandbox")
GATEWAY = os.environ.get("GATEWAY_URL", "http://localhost:4000")
ADMIN_TOKEN = os.environ.get("ADMIN_TOKEN", "")
KEYS = {"marketing": "ag_dev_marketing_123", "sales": "ag_dev_sales_456", "hr": "ag_dev_hr_789"}


def mcp(key, method, params=None):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}).encode()
    req = urllib.request.Request(f"{GATEWAY}/mcp", data=body, method="POST", headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {KEYS.get(key, key)}",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode()
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, None
    # Response is Server-Sent Events: "event: message\ndata: {...}"
    for line in raw.splitlines():
        if line.startswith("data:"):
            return status, json.loads(line[5:].strip())
    return status, json.loads(raw) if raw.strip().startswith("{") else None


def fill(value):
    if isinstance(value, str):
        return value.replace("{SANDBOX}", SANDBOX)
    if isinstance(value, dict):
        return {k: fill(v) for k, v in value.items()}
    return value


def check_text(text, exp, prefix=""):
    for s in exp.get(prefix + "contains", []):
        if s not in text:
            return f"missing {s!r}"
    for s in exp.get(prefix + "not_contains", []):
        if s in text:
            return f"leaked {s!r}"
    return None


def run_gateway_case(c):
    exp = c["expect"]
    if "method" in c:
        status, _ = mcp(c["key"], c["method"])
        return status == exp["http_status"], f"HTTP {status}"
    status, msg = mcp(c["key"], "tools/call", {"name": c["tool"], "arguments": fill(c.get("args", {}))})
    if not msg or "result" not in msg:
        return False, f"HTTP {status}, no result: {msg}"
    res = msg["result"]
    text = "\n".join(b.get("text", "") for b in res.get("content", []))
    allowed = not res.get("isError", False)
    if "allowed" in exp and allowed != exp["allowed"]:
        return False, f"expected {'allowed' if exp['allowed'] else 'blocked'}, got {'allowed' if allowed else 'blocked'}: {text[:120]}"
    problem = check_text(text, exp)
    return problem is None, problem or ("allowed" if allowed else "blocked: " + text[:90])


def run_agent_case(c):
    cmd = [str(ROOT / "node_modules/.bin/tsx"), str(ROOT / "apps/demo-agent/src/index.ts"), "--as", c["team"], "--json", c["prompt"]]
    out = None
    for attempt in range(2):  # the LLM provider can be briefly overloaded: retry once
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=300, cwd=ROOT)
        try:
            out = json.loads(p.stdout.strip().splitlines()[-1])
        except Exception:
            return False, f"agent failed: {p.stderr[-200:] or p.stdout[-200:]}"
        if not out.get("error"):
            break
    if out.get("error"):
        return False, f"LLM provider error (not a security failure): {out['error'][:120]}"
    exp = c["expect"]
    called = [t["name"] for t in out.get("toolCalls", []) if not t["blocked"]]
    for t in exp.get("must_call", []):
        if t not in called:
            return False, f"did not call {t} (called {called})"
    problem = check_text(out.get("answer", ""), exp, "answer_")
    return problem is None, problem or f"answer: {out.get('answer', '')[:90]!r}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent", action="store_true", help="also run Gemini end-to-end cases")
    ap.add_argument("--threshold", type=float, default=float(os.environ.get("EVAL_THRESHOLD", 1.0)))
    args = ap.parse_args()

    cases = json.loads((ROOT / "evals/cases.json").read_text())
    results = []
    print(f"\n🧪 AgentGate evals against {GATEWAY}\n")
    for c in cases["gateway"]:
        ok, detail = run_gateway_case(c)
        results.append({"id": c["id"], "kind": "gateway", "passed": ok, "detail": detail})
        print(f"  {'✅' if ok else '❌'} {c['id']:<36} {detail}")
    if args.agent:
        print()
        for c in cases["agent"]:
            ok, detail = run_agent_case(c)
            results.append({"id": c["id"], "kind": "agent", "passed": ok, "detail": detail})
            print(f"  {'✅' if ok else '❌'} {c['id']:<36} {detail}")

    passed = sum(r["passed"] for r in results)
    failed = len(results) - passed
    rate = passed / len(results) if results else 0
    print(f"\n{passed}/{len(results)} passed ({rate:.0%}), threshold {args.threshold:.0%}\n")

    payload = {"passed": passed, "failed": failed, "results": results, "gitSha": os.environ.get("GITHUB_SHA")}
    (ROOT / "evals/eval-results.json").write_text(json.dumps(payload, indent=2))
    try:
        req = urllib.request.Request(f"{GATEWAY}/api/evals", data=json.dumps(payload).encode(), method="POST",
                                     headers={"Content-Type": "application/json", "x-admin-token": ADMIN_TOKEN})
        urllib.request.urlopen(req, timeout=10).read()
    except Exception as e:
        print(f"(could not post results to dashboard: {e})")

    sys.exit(0 if rate >= args.threshold else 1)


if __name__ == "__main__":
    main()
