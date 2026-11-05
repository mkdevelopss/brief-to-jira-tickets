"""Task 1: Client brief -> developer-ready task breakdown + Jira-style tickets + open questions.

    python brief_to_tickets.py briefs/clear_brief.txt
    python brief_to_tickets.py briefs/vague_brief.txt --out output/vague

Golden rule: never assume. Every extracted fact, task and acceptance criterion must quote the brief.
Anything the brief does not state becomes "Not specified" plus an open question.

Pipeline (one focused LLM prompt per stage, output checked in code before the next stage):
  1. Understand  : extract goals, features, users, constraints, integrations, deadlines, each with a verbatim quote
  2. Detect gaps : missing info, vague wording, contradictions (both quotes), undefined terms, scope gaps -> questions
  3. Break down  : epics -> tasks, each with description, acceptance criteria from the brief, source quote,
                   dependencies only when the brief states them
  4. Tickets     : built by CODE (not the LLM) from stage 3 + 2: fixed fields, IDs TASK-001..., "Not specified"
                   defaults, open questions attached -> status "Needs clarification" or "Ready for development"
  5. Output      : on screen + output/<name>.md, tickets.csv (Jira import), tickets.json

Checks in code ("check, do not trust"):
  * every quote must appear in the brief (whitespace/case-insensitive); unsupported items are dropped and listed
  * priority / estimate / deadline are kept only if their quote is in the brief, else "Not specified"
  * dependencies may only point at existing tickets
Uses the same .env as Track A (LLM_PROVIDER, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL). Keys are never printed.
"""

import argparse
import csv
import json
import os
import re
import sys

import requests

NS = "Not specified"


# ------------------------------------------------------------------ LLM
def load_env(path=".env"):
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def call_llm(system, user):
    provider = os.environ.get("LLM_PROVIDER", "openai").lower()
    key = os.environ.get("LLM_API_KEY", "")
    model = os.environ.get("LLM_MODEL", "openai/gpt-oss-120b")
    base = os.environ.get("LLM_BASE_URL", "https://api.groq.com/openai/v1").rstrip("/")
    if not key:
        sys.exit("LLM_API_KEY is not set (put it in .env).")
    if provider == "anthropic":
        r = requests.post("https://api.anthropic.com/v1/messages", timeout=180,
                          headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                          json={"model": model, "max_tokens": 6000, "temperature": 0, "system": system,
                                "messages": [{"role": "user", "content": user}]})
        r.raise_for_status()
        return "".join(b.get("text", "") for b in r.json()["content"])
    body = {"model": model, "temperature": 0, "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    r = requests.post(f"{base}/chat/completions", json=body, timeout=180,
                      headers={"Authorization": f"Bearer {key}"})
    if r.status_code == 400 and "response_format" in r.text:
        body.pop("response_format")
        r = requests.post(f"{base}/chat/completions", json=body, timeout=180,
                          headers={"Authorization": f"Bearer {key}"})
    if r.status_code >= 400:
        sys.exit(f"LLM error HTTP {r.status_code}: {r.text[:300]}")
    return r.json()["choices"][0]["message"]["content"]


def ask_json(stage, system, user, required, llm=call_llm, retries=1):
    """Call the LLM and parse a JSON object with the required top-level keys (one retry with the error)."""
    msg = user
    for attempt in range(retries + 1):
        raw = llm(system, msg)
        text = re.sub(r"^\s*```(?:json)?\s*|\s*```\s*$", "", raw.strip())
        try:
            data = json.loads(text if text.startswith("{") else re.search(r"\{.*\}", text, re.S).group(0))
            missing = [k for k in required if k not in data]
            if not missing:
                return data
            err = f"missing keys {missing}"
        except (ValueError, AttributeError) as e:
            err = f"invalid JSON ({e.__class__.__name__})"
        print(f"  [{stage}] answer rejected: {err}; asking again")
        msg = user + f"\n\nYour previous answer was rejected: {err}. Reply with ONE valid JSON object only."
    sys.exit(f"[{stage}] the AI did not return valid JSON after {retries + 1} attempts.")


# ------------------------------------------------------------------ checks
def _norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[“”\"'‘’`]", "", s or "")).strip().lower()


def quoted(quote, brief):
    q = _norm(quote)
    return bool(q) and q in _norm(brief)


GOLDEN = ("RULES: Use ONLY what the brief states. Never invent features, technologies, users, priorities, "
          "estimates or deadlines. Every item must include 'quote': an exact, word-for-word substring copied "
          "from the brief. If the brief does not state something, write \"Not specified\". "
          "Reply with ONE JSON object only.")


# ------------------------------------------------------------------ stages
def stage_understand(brief, llm):
    system = ("You are a requirements analyst. Extract only what this client brief explicitly states. " + GOLDEN)
    user = (f"BRIEF:\n<<<\n{brief}\n>>>\n\nReturn JSON: {{\"goals\": [{{\"text\":..., \"quote\":...}}], "
            "\"features\": [...same shape], \"users\": [...], \"constraints\": [...], \"integrations\": [...], "
            "\"deadlines\": [...], \"priorities\": [...]}. Empty list when the brief says nothing.")
    return ask_json("understand", system, user,
                    ["goals", "features", "users", "constraints", "integrations", "deadlines"], llm)


def stage_gaps(brief, facts, llm):
    system = ("You are a senior business analyst reviewing a client brief before development. Find problems; do "
              "NOT solve them and do NOT suggest answers. " + GOLDEN +
              " For missing information or scope gaps, 'quote' is the brief text the question relates to.")
    user = (f"BRIEF:\n<<<\n{brief}\n>>>\n\nFACTS ALREADY EXTRACTED:\n{json.dumps(facts, indent=1)}\n\n"
            "Return JSON: {\"questions\": [{\"type\": \"missing|vague|contradiction|undefined_term|scope_gap\", "
            "\"quote\": \"exact brief text\", \"second_quote\": \"for contradictions only, the other exact brief text\", "
            "\"question\": \"one specific question the client can answer\", \"about\": \"feature or topic it affects\"}]}. "
            "Check: target users, platforms, integrations, data, security, deadlines, priorities; vague words such as "
            "fast, modern, user-friendly, secure, simple, scalable; any two statements that disagree; names or acronyms "
            "never explained; things a feature obviously needs that the brief never mentions.")
    return ask_json("gaps", system, user, ["questions"], llm)


def stage_breakdown(brief, facts, questions, llm):
    system = ("You are a tech lead turning a brief into developer work. " + GOLDEN +
              " Acceptance criteria must be testable and each must quote the brief. Add a dependency ONLY when "
              "the brief states the order or link; otherwise leave it empty.")
    user = (f"BRIEF:\n<<<\n{brief}\n>>>\n\nFACTS:\n{json.dumps(facts, indent=1)}\n\n"
            f"OPEN QUESTIONS (already raised, do not answer them):\n{json.dumps(questions, indent=1)}\n\n"
            "Return JSON: {\"epics\": [{\"title\": ..., \"description\": ..., \"quote\": ..., \"tasks\": [{\"key\": \"T1\", "
            "\"title\": \"short action\", \"description\": \"what and why, in the brief's words\", \"quote\": ..., "
            "\"acceptance_criteria\": [{\"text\": ..., \"quote\": ...}], \"depends_on\": [\"T<n>\"], "
            "\"dependency_quote\": \"brief text that states the dependency, or empty\", "
            "\"priority\": {\"value\": \"... or Not specified\", \"quote\": \"\"}, \"estimate\": {same}, "
            "\"deadline\": {same}, \"question_indexes\": [indexes of OPEN QUESTIONS that block this task]}]}]}. "
            "Task keys T1, T2... are unique across all epics.")
    return ask_json("breakdown", system, user, ["epics"], llm)


# ------------------------------------------------------------------ verification + tickets (code, not LLM)
def verify_items(items, brief, label, dropped):
    keep = []
    for it in items or []:
        if isinstance(it, dict) and quoted(it.get("quote", ""), brief):
            keep.append(it)
        else:
            dropped.append(f"{label}: '{(it or {}).get('text', it) if isinstance(it, dict) else it}' (quote not found in brief)")
    return keep


def build(brief, facts, gaps, plan):
    dropped = []
    for k in list(facts):
        if isinstance(facts[k], list):
            facts[k] = verify_items(facts[k], brief, f"fact/{k}", dropped)
    questions = []
    for q in gaps.get("questions", []):
        if not quoted(q.get("quote", ""), brief):
            dropped.append(f"question '{q.get('question')}' (quote not found)")
            continue
        if q.get("type") == "contradiction" and not quoted(q.get("second_quote", ""), brief):
            dropped.append(f"contradiction '{q.get('question')}' (second quote not found)")
            continue
        questions.append(q)
    for i, q in enumerate(questions, 1):
        q["id"] = f"Q-{i:02d}"

    tickets, key_to_id, n = [], {}, 0
    for e_i, epic in enumerate(plan.get("epics", []), 1):
        if not quoted(epic.get("quote", ""), brief):
            dropped.append(f"epic '{epic.get('title')}' (quote not found)")
            continue
        n += 1
        epic_id = f"TASK-{n:03d}"
        tickets.append({"id": epic_id, "title": epic.get("title", ""), "type": "Epic",
                        "description": epic.get("description", ""), "acceptance_criteria": [],
                        "source": epic.get("quote", ""), "dependencies": [], "questions": [],
                        "priority": NS, "estimate": NS, "deadline": NS, "parent": ""})
        for t in epic.get("tasks", []):
            if not quoted(t.get("quote", ""), brief):
                dropped.append(f"task '{t.get('title')}' (quote not found)")
                continue
            n += 1
            tid = f"TASK-{n:03d}"
            key_to_id[t.get("key", tid)] = tid
            acs = verify_items(t.get("acceptance_criteria", []), brief, f"criterion of '{t.get('title')}'", dropped)
            field = {}
            for f in ("priority", "estimate", "deadline"):
                v = t.get(f) or {}
                ok = isinstance(v, dict) and v.get("value") and v.get("value") != NS and quoted(v.get("quote", ""), brief)
                field[f] = v["value"] if ok else NS
            qidx = [i for i in t.get("question_indexes", []) if isinstance(i, int)]
            tickets.append({"id": tid, "title": t.get("title", ""), "type": "Story",
                            "description": t.get("description", ""),
                            "acceptance_criteria": [a["text"] for a in acs], "source": t.get("quote", ""),
                            "dependencies": t.get("depends_on", []) if quoted(t.get("dependency_quote", ""), brief) else [],
                            "q_idx": qidx, **field, "parent": epic_id})
    # map dependencies and questions
    gq = gaps.get("questions", [])
    for tk in tickets:
        tk["dependencies"] = [key_to_id[d] for d in tk.get("dependencies", []) if d in key_to_id]
        qs = []
        for i in tk.pop("q_idx", []):
            if 0 <= i < len(gq) and gq[i] in questions:
                qs.append(gq[i]["id"])
        tk["questions"] = qs
        if tk["type"] != "Epic" and not tk["acceptance_criteria"]:
            tk["questions"].append("(no acceptance criteria stated in the brief)")
        tk["status"] = "Needs clarification" if tk["questions"] else "Ready for development"
    for q in questions:
        q["blocks"] = [tk["id"] for tk in tickets if q["id"] in tk["questions"]]
    return facts, questions, tickets, dropped


# ------------------------------------------------------------------ output
def render(name, brief, facts, questions, tickets, dropped):
    L = [f"# Tickets for: {name}", ""]
    L += ["## What the brief states", ""]
    for k, items in facts.items():
        if isinstance(items, list):
            L.append(f"**{k.capitalize()}:** " + ("; ".join(f"{i.get('text')} (\"{i.get('quote')}\")" for i in items) or NS))
    L += ["", "## Open questions for the client", ""]
    for q in questions:
        extra = f" vs \"{q.get('second_quote')}\"" if q.get("type") == "contradiction" else ""
        L.append(f"- **{q['id']}** [{q.get('type')}] {q.get('question')} (brief: \"{q.get('quote')}\"{extra}) "
                 f"blocks: {', '.join(q['blocks']) or 'general'}")
    L += ["", "## Tickets", ""]
    for t in tickets:
        L += [f"### {t['id']} [{t['type']}] {t['title']}  ({t['status']})",
              f"- **Description:** {t['description']}",
              "- **Acceptance criteria:** " + ("; ".join(t["acceptance_criteria"]) or NS),
              f"- **Source:** \"{t['source']}\"",
              f"- **Dependencies:** {', '.join(t['dependencies']) or 'None stated'}",
              f"- **Open questions:** {', '.join(t['questions']) or 'None'}",
              f"- **Priority / Estimate / Deadline:** {t['priority']} / {t['estimate']} / {t['deadline']}", ""]
    if dropped:
        L += ["## Removed by the verification step (not supported by a quote from the brief)", ""] + [f"- {d}" for d in dropped]
    return "\n".join(L)


def save(out, md_text, tickets, questions):
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
    open(out + ".md", "w", encoding="utf-8").write(md_text)
    json.dump({"tickets": tickets, "open_questions": questions}, open(out + "_tickets.json", "w", encoding="utf-8"), indent=2)
    with open(out + "_tickets.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["Issue ID", "Summary", "Issue Type", "Parent", "Description", "Acceptance Criteria",
                    "Source Reference", "Dependencies", "Open Questions", "Status", "Priority", "Estimate", "Due Date"])
        for t in tickets:
            w.writerow([t["id"], t["title"], t["type"], t["parent"], t["description"],
                        " | ".join(t["acceptance_criteria"]), t["source"], ", ".join(t["dependencies"]),
                        ", ".join(t["questions"]), t["status"], t["priority"], t["estimate"], t["deadline"]])


def run(brief, name, out, llm=call_llm):
    print(f"[1/4] Understanding the brief ({len(brief.split())} words)...")
    facts = stage_understand(brief, llm)
    print("[2/4] Detecting gaps, vague wording and contradictions...")
    gaps = stage_gaps(brief, facts, llm)
    print("[3/4] Breaking the work into epics and tasks...")
    plan = stage_breakdown(brief, facts, gaps.get("questions", []), llm)
    print("[4/4] Building and verifying tickets...")
    facts, questions, tickets, dropped = build(brief, facts, gaps, plan)
    text = render(name, brief, facts, questions, tickets, dropped)
    save(out, text, tickets, questions)
    print("\n" + text)
    print(f"\nSaved: {out}.md, {out}_tickets.csv, {out}_tickets.json | {len(tickets)} tickets, "
          f"{len(questions)} open questions, {len(dropped)} unsupported items removed")
    return tickets, questions, dropped


def main():
    p = argparse.ArgumentParser(description="Turn a client brief into tickets without assumptions.")
    p.add_argument("brief", help="text file with the client brief")
    p.add_argument("--out", help="output path prefix (default output/<brief name>)")
    a = p.parse_args()
    load_env()
    brief = open(a.brief, encoding="utf-8").read().strip()
    if len(brief.split()) < 5:
        sys.exit("The brief is empty or too short to analyse.")
    name = os.path.splitext(os.path.basename(a.brief))[0]
    run(brief, name, a.out or os.path.join("output", name))


if __name__ == "__main__":
    main()
