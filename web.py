"""Web frontend for Task 1: client brief -> open questions + Jira tickets.

    python task1/web.py          (from the track-a-pr-reviewer folder, so it finds .env)
    -> http://127.0.0.1:8100

Uses exactly the same pipeline as brief_to_tickets.py (same prompts, same quote
checks). Each run happens in a background job so the page can show which stage
is running. Keys stay on the server; the browser only ever sees results.

API
  POST /api/run      {"brief": "..."}  -> {"job": id}
  GET  /api/jobs/<id>                   -> {"stage": 0-4, "status": "running|done|error", "result"|"error"}
  GET  /api/samples                     -> the demo briefs in briefs/
"""

import os
import sys
import threading
import time
import uuid

from flask import Flask, jsonify, request, send_from_directory

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import brief_to_tickets as b2t  # noqa: E402

STATIC = os.path.join(HERE, "web_static")
STAGES = ["Understanding the brief", "Finding gaps, vague words and contradictions",
          "Breaking the work into epics and tasks", "Checking quotes and building tickets"]
MAX_WORDS = 4000

for env_path in (os.path.join(HERE, ".env"), os.path.join(os.path.dirname(HERE), ".env")):
    b2t.load_env(env_path)

app = Flask(__name__, static_folder=None)
jobs = {}
lock = threading.Lock()


def _set(job_id, **kw):
    with lock:
        jobs[job_id].update(kw)


def _run(job_id, brief, llm):
    try:
        _set(job_id, stage=0)
        facts = b2t.stage_understand(brief, llm)
        _set(job_id, stage=1)
        gaps = b2t.stage_gaps(brief, facts, llm)
        _set(job_id, stage=2)
        plan = b2t.stage_breakdown(brief, facts, gaps.get("questions", []), llm)
        _set(job_id, stage=3)
        facts, questions, tickets, dropped = b2t.build(brief, facts, gaps, plan)
        markdown = b2t.render("brief", brief, facts, questions, tickets, dropped)
        _set(job_id, stage=4, status="done", result={
            "facts": facts, "questions": questions, "tickets": tickets, "dropped": dropped,
            "markdown": markdown, "brief": brief, "words": len(brief.split()),
            "model": os.environ.get("LLM_MODEL", ""), "finished": time.strftime("%Y-%m-%d %H:%M"),
        })
    except SystemExit as e:  # the CLI pipeline stops with sys.exit("message") on AI/key problems
        _set(job_id, status="error", error=str(e.code) if e.code else "The AI step stopped.")
    except Exception as e:
        app.logger.exception("job failed")
        _set(job_id, status="error", error=f"Unexpected error ({e.__class__.__name__}). See the server log.")


def llm_function():
    """The real LLM call; tests and demos may replace this."""
    return b2t.call_llm


@app.post("/api/run")
def api_run():
    brief = (request.get_json(silent=True) or {}).get("brief", "").strip()
    words = len(brief.split())
    if words < 5:
        return jsonify(error="The brief is empty or too short to analyse (at least 5 words)."), 400
    if words > MAX_WORDS:
        return jsonify(error=f"The brief is {words:,} words; the limit is {MAX_WORDS:,}. Split it into parts."), 400
    if not os.environ.get("LLM_API_KEY"):
        return jsonify(error="LLM_API_KEY is not set on the server (.env). See the README."), 503
    job_id = uuid.uuid4().hex[:12]
    with lock:
        jobs[job_id] = {"stage": 0, "status": "running", "stages": STAGES, "started": time.time()}
        while len(jobs) > 100:
            jobs.pop(next(iter(jobs)))
    threading.Thread(target=_run, args=(job_id, brief, llm_function()), daemon=True).start()
    return jsonify(job=job_id, stages=STAGES), 202


@app.get("/api/jobs/<job_id>")
def api_job(job_id):
    with lock:
        job = dict(jobs.get(job_id) or {})
    if not job:
        return jsonify(error="Unknown job (the server may have restarted)."), 404
    job["elapsed"] = round(time.time() - job.pop("started"), 1)
    return jsonify(job)


@app.get("/api/samples")
def api_samples():
    out = []
    folder = os.path.join(HERE, "briefs")
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if name.endswith(".txt"):
            out.append({"name": name[:-4].replace("_", " ").title(),
                        "text": open(os.path.join(folder, name), encoding="utf-8").read()})
    return jsonify(out)


@app.get("/")
def index():
    return send_from_directory(STATIC, "index.html")


@app.get("/<path:path>")
def static_files(path):
    return send_from_directory(STATIC, path)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8100
    key = "set" if os.environ.get("LLM_API_KEY") else "NOT SET"
    print(f"Brief to Tickets web UI: http://127.0.0.1:{port}  | model {os.environ.get('LLM_MODEL', '?')} | LLM_API_KEY {key}")
    app.run(host="127.0.0.1", port=port, debug=False)
