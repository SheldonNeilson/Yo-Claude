// The tasks tab in the right-hand panel: background commands and subagents of this session (or all open sessions,
// grouped by session), with their output, so you can watch one without leaving the conversation you're in.
"use strict";
window.tasks = {
  list: [], open: null, output: null, seen: null, timer: null, scope: "session",

  running() { return this.list.filter((t) => t.status === "running"); },
  // Stopping. A command or agent Yo Claude holds a handle on is stopped through it; a subagent without one by interrupting its
  // session's reply; a command that outlived a restart by finding its process (by its command line) and ending it, after
  // showing what will be ended.
  stopPrompt(list, what) {
    const running = list.filter((t) => t.status === "running");
    if (!running.length) return toast("Nothing is running.");
    if (running.every((t) => !(t.task_id && !t.detached) && t.kind === "shell")) return this.stopTasks(running);   // only the process list's own confirmation, once
    const names = running.slice(0, 6).map((t) => "• " + (taskName(t) || "task")).join("\n") + (running.length > 6 ? `\n… and ${running.length - 6} more` : "");
    confirmBox(`Stop ${what || (running.length === 1 ? "this" : `these ${running.length}`)}?\n\n${names}\n\nWhat they have done so far stays; the work in progress is cut off.`, () => this.stopTasks(running));
  },
  async stopTasks(running) {
    const handle = (t) => t.task_id && !t.detached;
    const attached = running.filter(handle);
    const loose = running.filter((t) => !handle(t) && t.kind === "agent");
    const orphans = running.filter((t) => !handle(t) && t.kind === "shell");
    for (const t of attached) { const err = await api().stop_task(t.session, t.task_id); if (err) toast(err, "error"); }
    for (const sid of new Set(loose.map((t) => t.session))) await api().stop_session(sid);
    const found = [];
    for (const t of orphans) for (const p of (await api().task_processes(t.key)) || []) if (!found.some((f) => f.pid === p.pid)) found.push(p);
    if (orphans.length && !found.length) toast("Couldn't find its process: it may have ended already.");
    else if (found.length) {
      const lines = found.slice(0, 6).map((p) => `• ${p.name} (${p.pid}): ${p.cmd.slice(0, 90)}`).join("\n");
      confirmBox(`Yo Claude lost track of ${orphans.length === 1 ? "this command" : "these commands"} when it restarted. End ${found.length === 1 ? "this process" : `these ${found.length} processes`} and everything they started?\n\n${lines}`,
        async () => { const failed = await api().kill_processes(found.map((p) => p.pid)); toast(failed && failed.length ? `Couldn't end ${failed.length}` : "Ended", failed && failed.length ? "error" : undefined); this.poll(); });
    }
    this.poll();
  },
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
    this.seen = new Set(list.map((t) => t.key));
    this.list = list;
    // A task starting never switches the panel away from where you put it: the tasks tab just pulses for a bit.
    if (fresh.length) this.flashUntil = Date.now() + 4000;
    if (panel.shown() && panel.tab === "tasks") this.render();
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
    const slow = new Promise((r) => setTimeout(() => r({ error: "Couldn't load its output (no answer after 15 s). Click the refresh button to try again." }), 15000));
    const out = await Promise.race([loadingWhile("tasks", "#panel", api().task_output(key), "output").catch((e) => ({ error: String(e) })), slow]);
    if (key !== this.open) return;
    this.output = out;
    const pre = $("#taskOut");
    if (!pre) return this.render();
    if (out.items) {   // a subagent: redraw its log when it has new steps; follow it only while the toggle is on
      if (+pre.dataset.n === out.items.length) return;
      const pb = $("#pbody"), keep = pb.scrollTop;
      follow.bind("task", pb);   // (watching your scrolling from the first draw on: before, the first scroll up was not noticed and the next refresh took you back down)
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
    panel.rememberFocus();
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
    const live = (this.scope === "session" ? mine : this.list).filter((x) => x.status === "running");
    if (live.length) {
      bar.appendChild(el("span", "spacer"));
      const all = el("button", "danger", `stop all <i>${live.length}</i>`);
      all.title = this.scope === "session" ? "Stop everything running in this session" : "Stop everything running in every session";
      all.onclick = () => this.stopPrompt(live, `${live.length === 1 ? "the task" : `all ${live.length} running tasks`} ${this.scope === "session" ? "in this session" : "in every session"}`);
      bar.appendChild(all);
    }
    body.appendChild(bar);
    body.appendChild(panel.filterBar("tasks", "search the tasks…", () => panel.domFilter(body, "tasks")));
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
        const name = taskName(x), raw = x.kind === "shell" ? (x.command || x.description || "") : "";
        row.innerHTML = `<span class="tstat">${taskIcon(x)}</span>` +
          `<div class="tmain"><div class="tdesc">${esc(name)}</div>` +
          (raw && raw !== name ? `<div class="tcmd" title="${esc(raw)}">${esc(raw)}</div>` : "") +   // (the command itself, when the name is made from it)
          `<div class="tmeta">${x.kind === "agent" ? `agent${x.agent_type && x.agent_type !== "general-purpose" ? " · " + esc(x.agent_type) : ""}` : "command"}` +
          ` · ${esc(elapsed(x))}${taskId(x) ? ` <span class="tid" title="${esc(x.kind === "agent" ? x.agent_id : x.task_id)}">#${esc(taskId(x))}</span>` : ""}</div></div>`;
        if (x.status === "running") {
          const k = el("button", "tstop danger", "✕");
          k.title = "Stop it";
          k.onclick = (e) => { e.stopPropagation(); this.stopPrompt([x]); };
          row.appendChild(k);
        }
        row.title = `${raw || x.description}
${statusWord(x)} · in “${x.title}”
Click to see its output`;
        row.onclick = () => this.show(x.key);
        list.appendChild(row);
      }
      body.appendChild(list);
    }
    panel.domFilter(body, "tasks");
    body.scrollTop = keep;
  },
  renderOne(body, t) {
    // the header and its buttons stay pinned to the top of the panel however far down the log you've scrolled
    const top = el("div", "tasktop");
    const head = el("div", "phead taskhead");
    const back = el("button", "", "← tasks");
    back.onclick = () => { this.open = null; this.output = null; this.render(); };
    head.append(back, el("span", "tdesc", `${taskIcon(t)} ${esc(taskName(t))}`));
    top.appendChild(head);
    body.appendChild(top);
    const info = el("div", "pinfo", `${esc(statusWord(t))} · ${esc(elapsed(t))} · ${t.kind === "agent" ? "subagent" : "background command"}${t.kind === "agent" && t.agent_id ? ` · <span class="tid">#${esc(t.agent_id)}</span>` : ""}` +
      `<br>in <span class="tsess">${esc(t.title)}</span>` + (t.summary ? `<br>${esc(t.summary)}` : ""));
    const bar = el("div", "phead");
    if (t.session !== S.active?.id) {
      const go = el("button", "primary", "open its conversation");
      go.onclick = () => api().open_session(t.session, t.cwd);
      bar.appendChild(go);
    }
    if (t.status === "running") {
      const stop = el("button", "danger", "stop");
      stop.onclick = () => this.stopPrompt([t]);
      bar.appendChild(stop);
    }
    const copy = el("button", "", "copy");
    copy.onclick = () => copyText(this.output?.text ?? $("#taskOut")?.textContent ?? "", "output copied");
    bar.appendChild(copy);
    const whole = t.kind === "shell" ? (t.command || t.description || "") : "";   // (the whole command: the header only has room for its start)
    if (whole) {
      const cc = el("button", "", "copy command");
      cc.onclick = () => copyText(whole, "command copied");
      bar.appendChild(cc);
    }
    bar.appendChild(follow.button("task"));
    top.appendChild(bar);
    body.appendChild(info);
    if (t.kind === "shell") this.renderFacts(body, t, whole);
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
    pre.textContent = this.output ? (this.output.error || this.output.text || (this.output.note === "Its output file isn't known." ? "(no output file: see above)" : this.output.note) || "(no output yet)") : "loading…";
    body.appendChild(pre);
    if (this.output?.cut) pre.before(el("div", "dim small tcut", "showing the end of the output"));
    follow.bind("task", pre);
    if (follow.on.task) follow.stick("task", pre); else pre.scrollTop = follow.pos.taskOut ?? 0;
  },
  // A background command: its whole command (wrapped), when it started, where its output is, and, when Yo Claude has no output
  // file for it (it started before a restart), the processes it is running as. A command that has said nothing for a long time
  // is flagged: it may be stuck.
  renderFacts(body, t, whole) {
    const facts = el("div", "taskfacts");
    if (whole) { const c = el("pre", "viewer taskcmd"); c.textContent = whole; facts.appendChild(c); }
    const rows = [["started", t.started ? `${whenText(t.started)} (${fullWhen(t.started)})` : "unknown"]];
    if (t.ended) rows.push(["ended", fullWhen(t.ended)]);
    rows.push(["output", t.output_file ? esc(t.output_file) : "not recorded: it started before Yo Claude last restarted"]);
    if (t.task_id) rows.push(["task id", esc(t.task_id)]);
    if (t.kind === "agent" && t.agent_id) rows.push(["agent id", esc(t.agent_id)]);
    facts.appendChild(el("div", "tfacts", rows.map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join("")));
    const loop = /\b(until|while)\b[\s\S]*\bsleep\b/.test(whole), age = t.started ? Date.now() / 1000 - t.started : 0;   // (a wait loop: polls until something appears)
    if (t.status === "running" && (t.idle_s > 600 || (loop && age > 900))) {
      const why = t.idle_s > 600 ? `Its output hasn't changed for ${Math.round(t.idle_s / 60)} minutes.` : `It has been waiting for ${Math.round(age / 60)} minutes.`;
      facts.appendChild(el("div", "tstuck", `⚠ ${why} If it's a wait loop (until … sleep), its marker may never match: a log written as UTF-16 hides text from grep. You can stop it.`));
    }
    body.appendChild(facts);
    if (t.status === "running" && !t.output_file) {   // nothing to read: show what it runs as, which is all there is to see
      const ps = el("div", "tprocs", "looking for its process…");
      facts.appendChild(ps);
      api().task_processes(t.key).then((found) => {
        if (this.open !== t.key) return;
        ps.innerHTML = found && found.length
          ? "<div class=\"dim small\">Running as:</div>" + found.map((p) => `<div class="tproc"><b>${esc(p.name)}</b> pid ${p.pid}${p.started ? " · started " + esc(whenText(new Date(p.started).getTime() / 1000)) : ""}<br><span class="dim">${esc(p.cmd)}</span></div>`).join("")
          : "<span class=\"dim\">No process found for it: it has probably ended.</span>";
      }).catch(() => { ps.textContent = ""; });
    }
  },
  // A subagent's work laid out like the conversation: its brief, what it said, its tool calls folded into
  // "N steps" (click to see each one; the latest run stays open while it works) and its report back.
  agentLog(items, running) {
    // the same Options > Chat switches as the main chat: thoughts are shown in full unless Fold Thinking is on; steps stay open unless Fold Commands is on
    const foldThoughts = S.settings.collapse_thinking === true, foldCommands = S.settings.collapse_commands !== false;
    const log = el("div", "agentlog");
    log.id = "taskOut"; log.dataset.n = items.length;
    for (let i = 0; i < items.length;) {
      const it = items[i];
      if (it.kind === "tool") {
        const start = i, run = [];
        while (i < items.length && items[i].kind === "tool") run.push(items[i++]);
        const live = running && i === items.length;   // the run it's on now lists its steps, unless you fold it
        const open = this.runOpen?.has(start) ? this.runOpen.get(start) : live || !foldCommands;
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
      if (it.kind === "thinking" && !foldThoughts) {   // like the main chat: each thought in full, wrapped
        log.appendChild(el("div", "alog-thinkbox", `<div class="alog-th">✻ thinking${whenHtml(it.ts)}</div>${esc(it.text)}`));
        i++;
        continue;
      }
      if (it.kind === "thinking") {   // back-to-back thoughts under one title (click to read them)
        const start = i, run = [];
        while (i < items.length && items[i].kind === "thinking") run.push(items[i++]);
        const key = "t" + start, open = this.runOpen?.has(key) ? this.runOpen.get(key) : false;
        const g = el("div", "alog-steps alog-thinking" + (open ? " open" : ""));
        const head = el("div", "alog-head", `<span class="tw">${open ? "▾" : "▸"}</span><b>✻ Thinking</b>` +
          `<span class="dim">${run.length} thought${run.length > 1 ? "s" : ""}</span><span class="spacer"></span>${whenHtml(run[0].ts)}`);
        head.onclick = () => {
          this.runOpen = this.runOpen || new Map();
          this.runOpen.set(key, !open);
          log.replaceWith(this.agentLog(items, running));
        };
        g.appendChild(head);
        if (open) { const list = el("div", "alog-list"); for (const r of run) list.appendChild(el("div", "alog-thought", esc(r.text))); g.appendChild(list); }
        log.appendChild(g);
        continue;
      }
      const at = i++;   // (this item's place: the key for what you've opened)
      const when = whenHtml(it.ts, "bubble-when");
      const opened = (k) => !!this.runOpen?.get(k);
      const toggle = (k, node, cls) => { this.runOpen = this.runOpen || new Map(); const on = !opened(k); this.runOpen.set(k, on); node.classList.toggle(cls, on); };
      if (it.kind === "user") {
        // like the main chat: your brief as a message, a few lines of it (click for the rest); injected <system-reminder> text as a small folded note
        const parts = String(it.text || "").split(/<system-reminder>([\s\S]*?)(?:<\/system-reminder>|$)/);
        for (let p = 0; p < parts.length; p++) {
          const text = parts[p].trim();
          if (!text) continue;
          const k = `u${at}.${p}`;
          if (p % 2) {
            const note = el("div", "alog-sysnote" + (opened(k) ? " open" : ""));
            note.appendChild(el("div", "alog-head", `<span class="tw">ⓘ</span><b>System note</b><span class="dim">${esc(text.replace(/\s+/g, " ").slice(0, 120))}</span>`));
            note.appendChild(el("div", "alog-sysbody", esc(text)));
            note.firstChild.onclick = () => toggle(k, note, "open");
            log.appendChild(note);
          } else {
            const m = el("div", "msg user alog-msg" + (opened(k) ? " open" : ""));
            m.appendChild(el("div", "alog-msgtext", esc(text)));
            if (text.length > 260 || text.split(String.fromCharCode(10)).length > 5) {
              const more = el("div", "alog-more", opened(k) ? "▾ less" : "▸ all of it");
              m.appendChild(more);
              m.onclick = () => { if (!getSelection().toString()) { toggle(k, m, "open"); more.textContent = opened(k) ? "▾ less" : "▸ all of it"; } };
            }
            m.insertAdjacentHTML("beforeend", when);
            log.appendChild(m);
          }
        }
      }
      else if (it.kind === "report") { const m = el("div", "msg assistant alog-msg open", `<div class="alog-rh">✓ reported back</div>${md(it.text)}`); m.insertAdjacentHTML("beforeend", when); log.appendChild(m); }
      else { const m = el("div", "msg assistant alog-msg open", md(it.text)); m.insertAdjacentHTML("beforeend", when); log.appendChild(m); }
    }
    if (!items.length) log.appendChild(el("div", "pempty", "Nothing yet."));
    return log;
  },
};

// A background command's name for the list: the description Claude gave it, or, when the "description" is just the command
// itself, a short name made from it ("Wait for fix15_view.txt", "npm run build", "Run unity.ps1 in sg2_bushes2"). The command
// itself shows under it.
const CMD_LIKE = /[|;&><$]|^\s*(cd|until|while|for|if|python3?|py|node|npm|pnpm|yarn|npx|git|dotnet|pwsh|powershell|bash|sh|ls|cat|tail|head|grep|rm|cp|mv|curl|sleep|echo)\b|^\s*(\.{1,2}[\\/]|[A-Za-z]:[\\/])/i;
const baseName = (p) => (p || "").replace(/["']/g, "").split(/[\\/]/).filter(Boolean).pop() || p || "";
const PATHISH = /(?:^|\s)((?:\/|[A-Za-z]:[\\/]|\.{1,2}[\\/]|~\/)[^\s"';|&\]]*)/;
function commandName(t) {
  const raw = (t.command || t.description || "").trim().replace(/^Running\s+/i, "");
  if (!raw) return "background command";
  if (t.description && t.command && t.description !== t.command && !CMD_LIKE.test(t.description)) return t.description;   // Claude's own label
  if (!CMD_LIKE.test(raw)) return raw.length > 60 ? raw.slice(0, 59) + "…" : raw;   // a plain label, or too bare to improve
  let cmd = raw.replace(/\s+/g, " "), dir = "", m;
  const cd = cmd.match(/^cd\s+(?:\/d\s+)?("[^"]+"|'[^']+'|\S+)\s*(?:&&|;)\s*/i);
  if (cd) { dir = baseName(cd[1]); cmd = cmd.slice(cd[0].length); }
  const inDir = dir && dir !== "." && dir !== "~" ? ` in ${dir}` : "";
  if (/^(?:until|while)\b/i.test(cmd)) {   // a poll loop: waiting for a file to say something
    const files = [...cmd.matchAll(new RegExp(PATHISH.source, "g"))].map((x) => x[1]).filter((p) => !/^\/dev\//.test(p));
    return files.length ? "Wait for " + baseName(files[0]) : "Wait loop" + inDir;
  }
  if ((m = cmd.match(/^tail\s+(?:-\S+\s+)*(\S+)/i)) && /\s-[a-z]*f/i.test(cmd)) return "Watch " + baseName(m[1]);
  if ((m = cmd.match(/^sleep\s+(\d+)/i))) return `Wait ${m[1]}s`;
  if ((m = cmd.match(/^(npm|pnpm|yarn)\s+(run\s+)?(\S+)/i))) return `${m[1]} ${m[2] ? "run " : ""}${m[3]}${inDir}`;
  if ((m = cmd.match(/^dotnet\s+(\S+)/i))) return `dotnet ${m[1]}${inDir}`;
  if ((m = cmd.match(/^git\s+(\S+)/i))) return `git ${m[1]}${inDir}`;
  if ((m = cmd.match(/^(?:python3?|py|node|pwsh|powershell|bash|sh)\s+(?:-\S+\s+)*("[^"]+"|'[^']+'|\S+)/i)) && !/^[-$({]/.test(m[1])) return `Run ${baseName(m[1])}${inDir}`;
  if ((m = cmd.match(/(\S+\.(?:ps1|sh|bat|cmd|py))\b/i))) return `Run ${baseName(m[1])}${inDir}`;
  const words = cmd.split(" "), prog = baseName(words[0]).replace(/\.exe$/i, ""), arg = words.slice(1).find((w) => !w.startsWith("-"));
  const name = arg && !/^[$({]/.test(arg) ? `${prog} ${baseName(arg)}` : prog;
  return (name.length > 50 ? name.slice(0, 49) + "…" : name) + inDir;
}
const taskName = (t) => (t.kind === "shell" ? commandName(t) : t.description) || "task";
// The state colour of a task, as a class: running (violet), finished (green), failed (red), stopped (dim)
const taskState = (t) => (t.status === "running" ? "running" : t.status === "failed" ? "failed" : ["killed", "stopped"].includes(t.status) ? "stopped" : "done");
// What kind of task it is, at a glance: a subagent is a little Claude (✻) and a command a little terminal (>_), both in the
// colour of its state (running ones move).
function taskIcon(t) {
  const st = taskState(t);
  return t.kind === "agent"
    ? `<span class="ticon agent ${st}" title="Subagent · ${esc(statusWord(t))}">✻</span>`
    : `<span class="ticon cmd ${st}" title="Command · ${esc(statusWord(t))}">&gt;${st === "running" ? '<span class="bspin">⠋</span>' : "_"}</span>`;   // (running: the terminal spinner inside the box, where the cursor would be)
}
// A short id for each, quiet but findable: a subagent's, or a command's task id (the whole of it is in the tooltip and the detail)
const taskId = (t) => String((t.kind === "agent" ? t.agent_id : t.task_id) || "").slice(0, 7);
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
