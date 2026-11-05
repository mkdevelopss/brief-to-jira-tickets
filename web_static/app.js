/* Brief to Tickets page. Everything shown comes from the server's pipeline result. */
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const main = $("#main");
  const { esc, store, toast, download, copy } = UI;
  const TYPE = {
    contradiction: ["bad", "Contradiction"], missing: ["warn", "Missing information"], vague: ["warn", "Vague wording"],
    undefined_term: ["accent", "Undefined term"], scope_gap: ["accent", "Scope gap"],
  };
  let result = null, tab = "tickets", ticketFilter = "all", draft = store.get("draft", "");

  /* ---------- routing ---------- */
  function route() {
    const h = location.hash;
    $("#nav-new").toggleAttribute("aria-current", h === "#new" || h === "");
    $("#nav-history").toggleAttribute("aria-current", h === "#history");
    if (h === "#history") renderHistory();
    else if (h === "#results" && result) renderResults();
    else renderInput();
  }
  window.addEventListener("hashchange", route);

  /* ---------- input ---------- */
  function renderInput() {
    main.innerHTML = `
      <div class="hero" style="display:flex;flex-direction:column;gap:10px;padding-top:12px">
        <span class="eyebrow">Task 1 · Client brief → developer-ready tickets</span>
        <h1>Turn a messy brief into tickets, without guessing</h1>
      </div>
      <div class="split">
        <div class="card">
          <div class="toolbar"><h2>Client brief</h2><span class="muted small" id="wc"></span></div>
          <div class="drop" id="drop">
            <label for="brief" class="sr">Client brief</label>
            <textarea id="brief" class="input" placeholder="Paste the client's brief here, or drop a .txt file…">${esc(draft)}</textarea>
          </div>
          <div class="toolbar">
            <div class="left">
              <button class="btn btn-primary" id="go">Create tickets</button>
              <label class="btn btn-ghost" for="file">Upload .txt</label><input id="file" type="file" accept=".txt,.md,text/plain" hidden>
              <button class="btn btn-ghost" id="clear">Clear</button>
            </div>
            <div class="left" id="samples"><span class="muted small">Try a sample:</span></div>
          </div>
          <div id="err"></div>
        </div>
        <div class="card">
          <h2>How it works</h2>
          <ol class="how">
            <li><span><b>Understand</b><span class="muted small">The AI lists only what the brief states, each with the client's exact words.</span></span></li>
            <li><span><b>Find gaps</b><span class="muted small">Missing information, vague words, contradictions, unknown names and scope gaps become questions.</span></span></li>
            <li><span><b>Plan</b><span class="muted small">Epics and tasks, with test conditions copied from the brief.</span></span></li>
            <li class="code"><span><b>Check and build (code, not AI)</b><span class="muted small">Every quote must really exist in the brief; anything else is removed. Tickets get one fixed format.</span></span></li>
          </ol>
          <div class="rule"><b>Golden rule:</b> if the brief doesn't say it, the tool asks the client instead of guessing.</div>
        </div>
      </div>`;
    const ta = $("#brief");
    const wc = () => { const n = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0; $("#wc").textContent = `${n.toLocaleString()} words`; };
    wc();
    ta.addEventListener("input", () => { wc(); store.set("draft", ta.value); draft = ta.value; });
    $("#go").addEventListener("click", () => start(ta.value));
    $("#clear").addEventListener("click", () => { ta.value = ""; store.set("draft", ""); wc(); ta.focus(); });
    $("#file").addEventListener("change", (e) => readFile(e.target.files[0]));
    const drop = $("#drop");
    drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); readFile(e.dataTransfer.files[0]); });
    fetch("api/samples").then((r) => r.json()).then((list) => {
      $("#samples").insertAdjacentHTML("beforeend", list.map((s, i) => `<button class="btn btn-ghost btn-sm" data-sample="${i}">${esc(s.name)}</button>`).join(""));
      $("#samples").addEventListener("click", (e) => {
        const b = e.target.closest("[data-sample]"); if (!b) return;
        ta.value = list[+b.dataset.sample].text; ta.dispatchEvent(new Event("input"));
      });
    }).catch(() => {});
  }
  function readFile(f) {
    if (!f) return;
    if (f.size > 500000) { toast("That file is larger than 500 KB"); return; }
    f.text().then((t) => { const ta = $("#brief"); ta.value = t; ta.dispatchEvent(new Event("input")); toast(`Loaded ${f.name}`); });
  }

  /* ---------- run + progress ---------- */
  async function start(brief) {
    $("#err").innerHTML = "";
    const r = await fetch("api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ brief }) });
    const body = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
    if (!r.ok) { $("#err").innerHTML = `<div class="alert bad" role="alert">${esc(body.error)}</div>`; return; }
    poll(body.job, body.stages);
  }
  function renderProgress(stages, stage, elapsed) {
    main.innerHTML = `<div class="card progress-card" aria-live="polite">
      <div class="toolbar"><h2>Working on your brief</h2><span class="elapsed">${elapsed}s</span></div>
      <ol class="steps">${stages.map((s, i) => `<li class="${i < stage ? "done" : i === stage ? "active" : ""}"><span class="ring"></span>${esc(s)}</li>`).join("")}</ol>
      <p class="muted small">Three AI calls run one after another, each checked by code before the next. This usually takes 20–60 seconds.</p></div>`;
  }
  async function poll(id, stages) {
    renderProgress(stages, 0, 0);
    for (;;) {
      await new Promise((r) => setTimeout(r, 900));
      let j;
      try { j = await (await fetch(`api/jobs/${id}`)).json(); } catch (e) { continue; }
      if (j.status === "running") { renderProgress(stages, j.stage, j.elapsed); continue; }
      if (j.status === "error") {
        main.innerHTML = `<div class="alert bad" role="alert"><div><b>The run stopped</b><p>${esc(j.error)}</p>
          ${/429|rate limit/i.test(j.error) ? `<p class="small">The AI provider's per-minute limit was reached. Wait about a minute and try again.</p>` : ""}</div></div>
          <div><a class="btn btn-ghost" href="#new">Back to the brief</a></div>`;
        return;
      }
      result = { ...j.result, elapsed: j.elapsed };
      saveHistory(result); tab = "tickets"; ticketFilter = "all";
      location.hash === "#results" ? renderResults() : (location.hash = "#results");
      return;
    }
  }
  function saveHistory(r) {
    const h = store.get("runs", []);
    h.unshift(r); store.set("runs", h.slice(0, 6));
  }

  /* ---------- results ---------- */
  function renderResults() {
    const r = result, T = r.tickets, stories = T.filter((t) => t.type !== "Epic");
    const ready = stories.filter((t) => t.status === "Ready for development").length;
    main.innerHTML = `
      <div class="res-head">
        <div style="display:flex;flex-direction:column;gap:6px"><span class="eyebrow">Results</span><h1>${stories.length} tickets, ${r.questions.length} questions</h1>
          <p class="muted small">${r.words} words · ${esc(r.model || "LLM")} · ${esc(r.finished)}${r.elapsed ? ` · ${r.elapsed}s` : ""}</p></div>
        <div class="actions">
          <button class="btn btn-ghost btn-sm" data-copy-questions>Copy questions for the client</button>
          <div class="menu"><button class="btn btn-dark btn-sm" data-menu aria-expanded="false">Export ▾</button>
            <div class="menu-list" hidden><button data-export="csv">Jira CSV</button><button data-export="json">JSON</button><button data-export="md">Markdown report</button></div></div>
          <a class="btn btn-primary btn-sm" href="#new">New brief</a>
        </div>
      </div>
      <div class="grid-cards">
        ${stat("Tickets", stories.length, `${T.length - stories.length} epic(s)`)}${stat("Ready for development", ready)}
        ${stat("Needs clarification", stories.length - ready)}${stat("Open questions", r.questions.length, "", true)}
        ${stat("Removed by quote check", r.dropped.length, r.dropped.length ? "unsupported items" : "nothing invented")}
      </div>
      <div class="tabs" role="tablist">
        ${tabBtn("tickets", "Tickets", stories.length)}${tabBtn("questions", "Questions", r.questions.length)}
        ${tabBtn("brief", "Brief with sources", "")}${tabBtn("facts", "What the brief states", "")}${tabBtn("check", "Quote check", r.dropped.length)}
      </div>
      <div id="tab"></div>`;
    renderTab();
  }
  const stat = (l, v, sub, dark) => `<div class="stat${dark ? " dark" : ""}"><span class="eyebrow">${l}</span><b>${v}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</div>`;
  const tabBtn = (k, l, n) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}${n !== "" ? `<span class="count">${n}</span>` : ""}</button>`;

  function renderTab() {
    const el = $("#tab");
    if (tab === "tickets") el.innerHTML = ticketsView();
    if (tab === "questions") el.innerHTML = questionsView();
    if (tab === "brief") el.innerHTML = briefView();
    if (tab === "facts") el.innerHTML = factsView();
    if (tab === "check") el.innerHTML = checkView();
  }

  function ticketCard(t) {
    const needs = t.status !== "Ready for development";
    const field = (k, v) => `<div><span>${k}</span>${v === "Not specified" ? `<b class="ns">Not specified</b>` : `<b>${esc(v)}</b>`}</div>`;
    return `<article class="ticket${needs ? " needs" : ""}">
      <div class="top"><span class="id">${esc(t.id)}</span><span class="pill">${esc(t.type)}</span>
        <span class="pill ${needs ? "warn" : "good"}">${needs ? "Needs clarification" : "Ready"}</span>
        <button class="btn btn-ghost btn-sm" style="margin-left:auto" data-copy-ticket="${esc(t.id)}" aria-label="Copy ticket ${esc(t.id)}">Copy</button></div>
      <h4>${esc(t.title)}</h4>
      <p class="small">${esc(t.description)}</p>
      ${t.acceptance_criteria.length ? `<div><span class="eyebrow">Acceptance criteria</span><ul>${t.acceptance_criteria.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : `<p class="small muted">Acceptance criteria: Not specified</p>`}
      <div class="quote">“${esc(t.source)}”</div>
      <div class="meta">${field("Priority", t.priority)}${field("Estimate", t.estimate)}${field("Deadline", t.deadline)}</div>
      <div class="small">${t.dependencies.length ? `Depends on <b class="mono">${t.dependencies.map(esc).join(", ")}</b>` : `<span class="muted">No dependencies stated</span>`}</div>
      ${t.questions.length ? `<div class="top">${t.questions.map((q) => q.startsWith("Q-") ? `<button class="qlink" data-goto-q="${esc(q)}">${esc(q)}</button>` : `<span class="pill warn">${esc(q)}</span>`).join("")}</div>` : ""}
    </article>`;
  }
  function ticketsView() {
    const T = result.tickets, epics = T.filter((t) => t.type === "Epic");
    const keep = (t) => ticketFilter === "all" || (ticketFilter === "ready") === (t.status === "Ready for development");
    const groups = epics.map((e) => [e, T.filter((t) => t.parent === e.id && keep(t))]);
    const orphans = T.filter((t) => t.type !== "Epic" && !t.parent && keep(t));
    const b = (k, l) => `<button data-tfilter="${k}" aria-pressed="${ticketFilter === k}">${l}</button>`;
    return `<div class="toolbar" style="margin:16px 0"><div class="seg" role="group" aria-label="Filter tickets">${b("all", "All")}${b("ready", "Ready")}${b("needs", "Needs clarification")}</div>
        <span class="muted small">Sand top border = has open questions</span></div>
      <div style="display:flex;flex-direction:column;gap:26px">
      ${groups.map(([e, list]) => `<section class="epic"><div class="epic-head"><span class="pill accent">${esc(e.id)} · Epic</span><h3>${esc(e.title)}</h3>
          <span class="muted small">${list.length} ticket(s)</span></div>
          ${list.length ? `<div class="tickets">${list.map(ticketCard).join("")}</div>` : `<p class="muted small">No tickets match this filter.</p>`}</section>`).join("")}
      ${orphans.length ? `<section class="epic"><div class="tickets">${orphans.map(ticketCard).join("")}</div></section>` : ""}
      </div>`;
  }
  function questionsView() {
    const order = ["contradiction", "missing", "vague", "undefined_term", "scope_gap"];
    const by = {}; result.questions.forEach((q) => (by[q.type] = by[q.type] || []).push(q));
    const types = [...order.filter((k) => by[k]), ...Object.keys(by).filter((k) => !order.includes(k))];
    if (!types.length) return `<div class="empty" style="margin-top:16px">No open questions: the brief answered everything the tickets need.</div>`;
    return `<div style="display:flex;flex-direction:column;gap:22px;margin-top:16px">${types.map((k) => {
      const [cls, label] = TYPE[k] || ["", k];
      return `<section class="qgroup"><h3>${label} <span class="muted small">(${by[k].length})</span></h3>${by[k].map((q) => `
        <div class="q" id="${esc(q.id)}"><div class="top"><span class="mono small"><b>${esc(q.id)}</b></span><span class="pill ${cls}">${label}</span>
          <span class="muted small" style="margin-left:auto">${q.blocks.length ? `Blocks ${q.blocks.map(esc).join(", ")}` : "General"}</span></div>
          <p class="ask">${esc(q.question)}</p>
          <div class="quote">“${esc(q.quote)}”</div>${q.type === "contradiction" && q.second_quote ? `<div class="quote">vs “${esc(q.second_quote)}”</div>` : ""}
        </div>`).join("")}</section>`;
    }).join("")}</div>`;
  }
  function briefView() {
    const text = result.brief, marks = [];
    const add = (quote, cls, label) => {
      if (!quote) return;
      const i = text.toLowerCase().indexOf(quote.toLowerCase().trim());
      if (i >= 0) marks.push({ s: i, e: i + quote.trim().length, cls, label });
    };
    result.tickets.forEach((t) => add(t.source, "src-t", `${t.id}: ${t.title}`));
    result.questions.forEach((q) => { add(q.quote, "src-q", `${q.id}: ${q.question}`); add(q.second_quote, "src-q", `${q.id}: ${q.question}`); });
    marks.sort((a, b) => a.s - b.s || b.e - a.e);
    let out = "", pos = 0;
    marks.forEach((m) => { if (m.s < pos) return; out += esc(text.slice(pos, m.s)) + `<mark class="${m.cls}" title="${esc(m.label)}">${esc(text.slice(m.s, m.e))}</mark>`; pos = m.e; });
    out += esc(text.slice(pos));
    return `<div style="display:flex;flex-direction:column;gap:12px;margin-top:16px"><div class="legend"><span><mark class="src-t">green</mark> used as a ticket source</span><span><mark class="src-q">sand</mark> raised as a question</span><span>Hover a highlight to see which item uses it.</span></div>
      <div class="brief-text">${out}</div></div>`;
  }
  function factsView() {
    const f = result.facts, names = { goals: "Goals", features: "Features", users: "Users", constraints: "Constraints", integrations: "Integrations", deadlines: "Deadlines", priorities: "Priorities" };
    return `<div class="facts" style="margin-top:16px">${Object.keys(names).filter((k) => Array.isArray(f[k])).map((k) => `<div class="card"><h3>${names[k]}</h3>
      ${f[k].length ? `<ul>${f[k].map((i) => `<li>${esc(i.text)}<small>“${esc(i.quote)}”</small></li>`).join("")}</ul>` : `<p class="muted small">Not specified</p>`}</div>`).join("")}</div>`;
  }
  function checkView() {
    return `<div class="card" style="margin-top:16px"><h2>Quote check</h2>
      <p class="muted small">After every AI step, code checks that each quoted sentence really appears in the brief. Items that fail are removed before tickets are built.</p>
      ${result.dropped.length ? `<ul>${result.dropped.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>` : `<div class="alert good">Nothing removed: every fact, question, task and criterion matched a sentence in the brief.</div>`}</div>`;
  }

  /* ---------- exports ---------- */
  const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  function jiraCsv() {
    const head = ["Issue ID", "Summary", "Issue Type", "Parent", "Description", "Acceptance Criteria", "Source Reference", "Dependencies", "Open Questions", "Status", "Priority", "Estimate", "Due Date"];
    return [head.join(","), ...result.tickets.map((t) => [t.id, t.title, t.type, t.parent, t.description, t.acceptance_criteria.join(" | "), t.source,
      t.dependencies.join(", "), t.questions.join(", "), t.status, t.priority, t.estimate, t.deadline].map(csvCell).join(","))].join("\n");
  }
  function clientQuestions() {
    return ["Hello,", "", "Thank you for the brief. Before we start development, could you answer these questions?", "",
      ...result.questions.map((q, i) => `${i + 1}. ${q.question}\n   (Your brief: "${q.quote}"${q.second_quote ? ` vs "${q.second_quote}"` : ""})`), "", "Thank you!"].join("\n");
  }
  function ticketText(t) {
    return [`${t.id} [${t.type}] ${t.title}`, `Status: ${t.status}`, "", t.description, "", "Acceptance criteria:",
      ...(t.acceptance_criteria.length ? t.acceptance_criteria.map((a) => `- ${a}`) : ["Not specified"]), "", `Source: "${t.source}"`,
      `Dependencies: ${t.dependencies.join(", ") || "None stated"}`, `Open questions: ${t.questions.join(", ") || "None"}`,
      `Priority / Estimate / Deadline: ${t.priority} / ${t.estimate} / ${t.deadline}`].join("\n");
  }

  /* ---------- history ---------- */
  function renderHistory() {
    const runs = store.get("runs", []);
    main.innerHTML = `<div style="display:flex;flex-direction:column;gap:6px"><span class="eyebrow">History</span><h1>Recent runs</h1><p class="muted small">Stored only in this browser.</p></div>
      ${runs.length ? `<div class="hist">${runs.map((r, i) => `<button data-open-run="${i}"><b>${esc(r.brief.split("\n")[0].slice(0, 110))}</b>
        <span class="muted small">${esc(r.finished)} · ${r.tickets.filter((t) => t.type !== "Epic").length} tickets · ${r.questions.length} questions</span></button>`).join("")}</div>
        <div><button class="btn btn-ghost btn-sm" data-clear-runs>Clear history</button></div>` : `<div class="empty">No runs yet. <a href="#new">Analyse a brief</a></div>`}`;
  }

  /* ---------- events ---------- */
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button, a");
    if (!t) { document.querySelectorAll(".menu-list").forEach((m) => (m.hidden = true)); return; }
    if (t.dataset.tab) { tab = t.dataset.tab; document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b === t))); renderTab(); }
    else if (t.dataset.tfilter) { ticketFilter = t.dataset.tfilter; renderTab(); }
    else if (t.dataset.gotoQ) {
      tab = "questions"; document.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === "questions"))); renderTab();
      const q = document.getElementById(t.dataset.gotoQ); if (q) { q.scrollIntoView({ block: "center" }); q.classList.add("flash"); setTimeout(() => q.classList.remove("flash"), 1600); }
    }
    else if (t.hasAttribute("data-menu")) { const l = t.nextElementSibling; l.hidden = !l.hidden; t.setAttribute("aria-expanded", String(!l.hidden)); }
    else if (t.dataset.export) {
      if (t.dataset.export === "csv") download("tickets_jira.csv", jiraCsv(), "text/csv");
      if (t.dataset.export === "json") download("tickets.json", JSON.stringify({ tickets: result.tickets, open_questions: result.questions }, null, 2), "application/json");
      if (t.dataset.export === "md") download("tickets.md", result.markdown, "text/markdown");
      t.parentElement.hidden = true;
    }
    else if (t.hasAttribute("data-copy-questions")) copy(clientQuestions());
    else if (t.dataset.copyTicket) copy(ticketText(result.tickets.find((x) => x.id === t.dataset.copyTicket)));
    else if (t.dataset.openRun) { result = store.get("runs", [])[+t.dataset.openRun]; tab = "tickets"; location.hash = "#results"; }
    else if (t.hasAttribute("data-clear-runs")) { store.set("runs", []); renderHistory(); }
  });

  route();
})();
