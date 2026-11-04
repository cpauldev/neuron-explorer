"""Run one real explanation through the local app and preserve its evidence.

Creates a fresh chat by default; --chat observes an existing UI-submitted trial.
Leaves settings alone and never grants approvals.
Compare artifacts manually: tool counts and confidence alone are not quality scores.
"""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import time
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("label")
    parser.add_argument("--layer", type=int, default=19)
    parser.add_argument("--neuron", type=int, default=8930)
    parser.add_argument("--timeout", type=int, default=600)
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--chat", help="Observe an evaluation chat already submitted through the UI; does not send a message")
    parser.add_argument("--prompt", help="Custom benign research evaluation request (default: explain the selected neuron)")
    args = parser.parse_args()
    output = Path("output/evaluations") / args.label
    output.mkdir(parents=True, exist_ok=False)
    for name in ("agent_prompt.md", "agent_methodology.md"):
        content = (Path("explorer") / name).read_bytes()
        (output / name).write_bytes(content)

    def request(path, body=None):
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{args.port}/api/agent/{path}",
                                     data=data, headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)

    prompt = args.prompt or f"Explain L{args.layer} N{args.neuron}."
    started = time.monotonic()
    if args.chat:
        chat = args.chat
    else:
        receipt = request("send", {"provider": "codex", "message": prompt, "access": "project"})
        chat = receipt["chat"]
    print(json.dumps({"chat": chat, "prompt": prompt if not args.chat else "(observing UI-submitted request)"}), flush=True)
    seen = 0
    stop_reason = None
    while True:
        history = request(f"history?chat={chat}")
        for event in history["events"][seen:]:
            if event.get("t") in ("tool", "error", "done"):
                print(json.dumps({k: event[k] for k in ("t", "name", "error", "status") if k in event}), flush=True)
        seen = len(history["events"])
        if history.get("approvals") or time.monotonic() - started > args.timeout:
            stop_reason = "approval required" if history.get("approvals") else "time limit"
            request("interrupt", {"chat": chat})
            history = request(f"history?chat={chat}")
            history["evaluation_stopped"] = stop_reason
            break
        if not history["running"]:
            break
        time.sleep(2)
    (output / "history.json").write_text(json.dumps(history, ensure_ascii=False, indent=2), encoding="utf-8")
    tools = [e for e in history["events"] if e.get("t") == "tool"]
    results = {e["id"]: e for e in history["events"] if e.get("t") == "tool_result"}
    attempts = [e for e in tools if e.get("name", "").split("__")[-1] == "present_findings"]
    reports = [e.get("input") for e in attempts if e["id"] in results and not results[e["id"]].get("error")]
    done = next((e for e in reversed(history["events"]) if e.get("t") == "done"), {})
    user = next((e for e in history["events"] if e.get("t") == "user"), {})
    errors = list(dict.fromkeys(e["error"] for e in history["events"] if e.get("t") == "error" and e.get("error")))
    summary = {"chat": chat, "prompt": user.get("text", prompt), "seconds": round(time.monotonic() - started, 1),
               "submitted_via": "ui" if args.chat else "api",
               "turn_seconds": round(done["at"] - user["at"], 1) if done.get("at") and user.get("at") else None,
               "provider": history.get("provider"), "model": history.get("model"),
               "prompt_hashes": {name: hashlib.sha256((output / name).read_bytes()).hexdigest()
                                 for name in ("agent_prompt.md", "agent_methodology.md")},
               "tools": dict(collections.Counter(e["name"].split("__")[-1] for e in tools)),
               "reports": reports, "report_attempts": len(attempts), "stopped": stop_reason,
               "status": done.get("status", "incomplete"), "errors": errors,
               "completed_report": bool(reports and done.get("status") == "completed" and not errors and not stop_reason)}
    (output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "reports"}), flush=True)
    return 0 if summary["completed_report"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
