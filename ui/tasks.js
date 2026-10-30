// The tasks tab in the right-hand panel: background commands and subagents of this session (or all open sessions,
// grouped by session), with their output, so you can watch one without leaving the conversation you're in.
"use strict";
window.tasks = {
  list: [], open: null, output: null, seen: null, timer: null, scope: "session",

  running() { return this.list.filter((t) => t.status === "running"); },
  // Another conversation was opened: don't leave a different session's subagent on screen; show this one's tasks.
  sessionChanged() {
    const t = this.open && this.list.find((x) => x.key === this.open);
    if (this.open && (!t || !this.here(t))) { this.open = null; this.output = null; }
    this.scope = "session";
    if (panel.shown() && panel.tab === "tasks") this.render(); else panel.renderTabs();
  },
  here(t) { return t.session === S.active?.id; },
  runningHere() { return this.running().filter((t) => this.here(t)); },
  runningElsewhere() { return this.running().filter((t) => !this.here(t)); },
  async poll() {
    const list = await api().tasks() || [];
    const fresh = list.filter((t) => t.status === "running" && this.here(t) && this.seen && !this.seen.has(t.key));
    const first = this.seen === null;
    this.seen = new Set(list.map((t) => t.key));
    this.list = list;
    // A task starting in this session (or running when the window opens) brings the panel up on this tab.
    if (fresh.length || (first && this.runningHere().length)) this.show();
    else if (panel.shown() && panel.tab === "tasks") this.render();
    else panel.renderTabs();
    if (this.open && panel.shown() && panel.tab === "tasks") this.loadOutput();
  },
  show(key) {
    if (!panel.shown()) { $("#app").classList.add("with-panel"); api().set_setting("panel_open", true); }
    if (key !== undefined) { this.open = key; this.output = null; this.runOpen = new Map(); follow.set("task", true); }
    panel.tab = "tasks";
    panel.render();
    if (this.open) this.loadOutput();
  },
  async loadOutput() {
    const key = this.open;
    const out = await api().task_output(key);
    if (key !== this.open) return;
    this.output = out;
    const pre = $("#taskOut");
    if (!pre) return this.render();
    if (out.items) {   // a subagent: redraw its log when it has new steps; follow it only while the toggle is on
      if (+pre.dataset.n === out.items.length) return;
      const pb = $("#pbody"), keep = pb.scrollTop;
      const t = this.list.find((x) => x.key === key);
      pre.replaceWith(this.agentLog(out.items, t?.status === "running"));
      if (follow.on.task) follow.stick("task", pb); else pb.scrollTop = keep;
      return;
    }
    pre.textContent = out.error || out.text || out.note || "(no output yet)";
    follow.stick("task", pre);
  },

  render() {
    const body = $("#pbody");
    if (!body || panel.tab !== "tasks") return;
    panel.renderTabs();
    const keep = body.scrollTop;
    body.innerHTML = "";
    const t = this.open && this.list.find((x) => x.key === this.open);
    if (t) return this.renderOne(body, t);
    this.open = null;
    const mine = this.list.filter((x) => this.here(x));
    const bar = el("div", "phead taskscope");
    for (const [scope, label, n] of [["session", "this session", mine.length], ["all", "all sessions", this.list.length]]) {
      const b = el("button", this.scope === scope ? "on" : "", `${label}${n ? ` <i>${n}</i>` : ""}`);
      b.onclick = () => { this.scope = scope; this.render(); };
      bar.appendChild(b);
    }
    body.appendChild(bar);
    const shown = this.scope === "session" ? mine : this.list;
    if (!shown.length) {
      const others = this.list.length - mine.length;
      body.appendChild(el("div", "pempty", `No background tasks or subagents ${this.scope === "session" ? "in this session" : "yet"}.` +
        (this.scope === "session" && others ? `<br><br>${others} in other sessions: see <b>all sessions</b>.` :
         "<br><br>When Claude runs something in the background (a render, a build, a test run) or hands work to a subagent, it shows here with its output.")));
      return;
    }
    // All sessions: one group per session, this one first, then the one with the latest task.
    const groups = new Map();
    for (const x of [...shown].sort((a, b) => (this.here(b) - this.here(a)))) {
      if (!groups.has(x.session)) groups.set(x.session, []);
      groups.get(x.session).push(x);
    }
    for (const [sid, items] of groups) {
      if (this.scope === "all") {
        const h = el("div", "taskgroup" + (sid === S.active?.id ? " here" : ""),
          `<span>${esc(items[0].title)}</span>${sid === S.active?.id ? '<span class="dim">this session</span>' : ""}`);
        if (sid !== S.active?.id) {
          h.dataset.tip = "Open this conversation";
          h.onclick = () => api().open_session(sid, items[0].cwd);
        }
        body.appendChild(h);
      }
      const list = el("div", "tree tasklist");
      for (const x of items) {
        const row = el("div", "node task " + x.status);
        row.innerHTML = `<span class="tstat">${statusMark(x)}</span>` +
          `<div class="tmain"><div class="tdesc">${esc(x.description)}</div>` +
          `<div class="tmeta">${x.kind === "agent" ? `agent${x.agent_type && x.agent_type !== "general-purpose" ? " · " + esc(x.agent_type) : ""}` : "command"}` +
          ` · ${esc(elapsed(x))}</div></div>`;
        row.title = `${x.description}
${statusWord(x)} · in “${x.title}”
Click to see its output`;
        row.onclick = () => this.show(x.key);
        list.appendChild(row);
      }
      body.appendChild(list);
    }
    body.scrollTop = keep;
  },
  renderOne(body, t) {
    // the header and its buttons stay pinned to the top of the panel however far down the log you've scrolled
    const top = el("div", "tasktop");
    const head = el("div", "phead taskhead");
    const back = el("button", "", "← tasks");
    back.onclick = () => { this.open = null; this.output = null; this.render(); };
    head.append(back, el("span", "tdesc", `${statusMark(t)} ${esc(t.description)}`));
    top.appendChild(head);
    body.appendChild(top);
    const info = el("div", "pinfo", `${esc(statusWord(t))} · ${esc(elapsed(t))} · ${t.kind === "agent" ? "subagent" : "background command"}` +
      `<br>in <span class="tsess">${esc(t.title)}</span>` + (t.summary ? `<br>${esc(t.summary)}` : ""));
    const bar = el("div", "phead");
    if (t.session !== S.active?.id) {
      const go = el("button", "primary", "open its conversation");
      go.onclick = () => api().open_session(t.session, t.cwd);
      bar.appendChild(go);
    }
    if (t.status === "running" && t.task_id && !t.detached) {
      const stop = el("button", "danger", "stop");
      stop.onclick = async () => { const err = await api().stop_task(t.session, t.task_id); if (err) toast(err, "error"); };
      bar.appendChild(stop);
    }
    const copy = el("button", "", "copy");
    copy.onclick = () => copyText(this.output?.text ?? $("#taskOut")?.textContent ?? "", "output copied");
    bar.appendChild(copy);
    bar.appendChild(follow.button("task"));
    top.appendChild(bar);
    body.appendChild(info);
    if (this.output?.path) {
      const file = el("button", "", "open file");
      file.onclick = () => api().open_path(this.output.path, "open");
      bar.appendChild(file);
    }
    if (this.output?.items) {
      // render() runs on every task-list refresh while it works: only jump to the end while following,
      // otherwise put the view back where you'd scrolled to
      const keep = follow.pos.pbody ?? 0;
      body.appendChild(this.agentLog(this.output.items, t.status === "running"));
      follow.bind("task", body);
      if (follow.on.task) follow.stick("task", body); else body.scrollTop = keep;
      return;
    }
    const pre = el("pre", "viewer taskout");
    pre.id = "taskOut";
    pre.textContent = this.output ? (this.output.error || this.output.text || this.output.note || "(no output yet)") : "loading…";
    body.appendChild(pre);
    if (this.output?.cut) pre.before(el("div", "dim small tcut", "showing the end of the output"));
    follow.bind("task", pre);
    if (follow.on.task) follow.stick("task", pre); else pre.scrollTop = follow.pos.taskOut ?? 0;
  },
  // A subagent's work laid out like the conversation: its brief, what it said, its tool calls folded into
  // "N steps" (click to see each one; the latest run stays open while it works) and its report back.
  agentLog(items, running) {
    const log = el("div", "agentlog");
    log.id = "taskOut"; log.dataset.n = items.length;
    for (let i = 0; i < items.length;) {
      const it = items[i];
      if (it.kind === "tool") {
        const start = i, run = [];
        while (i < items.length && items[i].kind === "tool") run.push(items[i++]);
        const live = running && i === items.length;   // the run it's on now lists its steps, unless you fold it
        const open = this.runOpen?.has(start) ? this.runOpen.get(start) : live;
        const counts = {};
        for (const r of run) counts[r.name] = (counts[r.name] || 0) + 1;
        const failed = run.filter((r) => r.error).length;
        const g = el("div", "alog-steps" + (live ? " live" : "") + (open ? " open" : ""));
        const head = el("div", "alog-head", `<span class="tw">${open ? "▾" : "▸"}</span>` +
          `<b>${live ? `<span class="spin">${SPIN[Math.floor(Date.now() / 120) % SPIN.length]}</span> ` : ""}${run.length} step${run.length > 1 ? "s" : ""}</b>` +
          `<span class="dim">${Object.entries(counts).map(([n, c]) => esc(n.replace(/^mcp__[^_]+__/, "")) + (c > 1 ? ` ×${c}` : "")).join(" · ")}</span>` +
          (failed ? `<span class="del">${failed} failed</span>` : "") +
          (live ? `<span class="alog-now">${esc(run.at(-1).name)} ${esc(run.at(-1).brief)}</span>` : "") +
          `<span class="spacer"></span>${whenHtml(run[0].ts)}`);
        head.onclick = () => {
          this.runOpen = this.runOpen || new Map();
          this.runOpen.set(start, !open);
          log.replaceWith(this.agentLog(items, running));
        };
        g.appendChild(head);
        if (open) {
          const list = el("div", "alog-list");
          for (const r of run) list.appendChild(el("div", r.error ? "failed" : "", `<span class="tn">${esc(r.name.replace(/^mcp__[^_]+__/, ""))}</span> ${esc(r.brief)}`));
          g.appendChild(list);
        }
        log.appendChild(g);
        continue;
      }
      i++;
      const at = whenHtml(it.ts, "alog-when");
      if (it.kind === "user") log.appendChild(el("div", "alog-user", at + esc(it.text)));
      else if (it.kind === "report") log.appendChild(el("div", "alog-report", `<div class="alog-rh">✓ reported back ${at}</div>${md(it.text)}`));
      else log.appendChild(el("div", "alog-assistant", at + md(it.text)));
    }
    if (!items.length) log.appendChild(el("div", "pempty", "Nothing yet."));
    return log;
  },
};

function statusWord(t) {
  return { running: t.detached ? "running (since before the restart)" : "running", completed: "finished", done: "finished",
           failed: "failed", killed: "stopped", stopped: "stopped" }[t.status] || t.status;
}
function statusMark(t) {
  if (t.status === "running") return `<span class="spin tspin">${SPIN[Math.floor(Date.now() / 120) % SPIN.length]}</span>`;
  return t.status === "failed" ? '<span class="del">✗</span>' : ["killed", "stopped"].includes(t.status) ? '<span class="dim">■</span>' : '<span class="add">✓</span>';
}
function elapsed(t) {
  if (!t.started) return "";
  const s = Math.max(0, Math.round((t.ended || Date.now() / 1000) - t.started));
  const d = s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m` : s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
  return t.status === "running" ? d : `took ${d}, ${ago(t.ended * 1000)}${ago(t.ended * 1000) === "now" ? "" : " ago"}`;
}

// Every 2 s while anything is working (or the tab is open), otherwise every 15 s.
(function loop() {
  const active = S.busy.size || S.bg.size || tasks.running().length || (panel.shown() && panel.tab === "tasks");
  if (window.pywebview?.api) tasks.poll().catch(() => {});
  tasks.timer = setTimeout(loop, active ? 2000 : 15000);
})();
