// Yo Claude main window. Python pushes events through app.events([...]); we call window.pywebview.api.*.
"use strict";
const $ = (s) => document.querySelector(s);
const api = () => window.pywebview.api;
const S = { settings: {}, folder: null, folders: [], groups: [], sessions: [], active: null, items: [],
            display: { state: "starting" }, level: 0, filter: "" };
const itemEls = new Map();
let renderTimer = null;

const MODELS = [["", "model: default"], ["claude-fable-5-1", "Fable 5.1"], ["claude-opus-5-5", "Opus 5.5"],
                ["claude-sonnet-5-5", "Sonnet 5.5"], ["claude-haiku-5-5", "Haiku 5.5"]];
const EFFORTS = [["", "effort: default"], ["low", "effort: low"], ["medium", "effort: medium"], ["high", "effort: high"],
                 ["xhigh", "effort: xhigh"], ["max", "effort: max"]];
const PERMS = [["default", "ask before changes"], ["acceptEdits", "auto-accept edits"], ["plan", "plan mode"]];
const STATE_LABEL = { starting: "booting…", idle: "● ready", paused: "○ wake word off", listening: "◉ listening",
                      thinking: "✻ thinking…", speaking: "▶ speaking", using_pc: "⌖ using your pc",
                      approval: "! needs your ok", error: "✗ error" };
const SPIN = "·✢✳✶✻✽✻✶✳✢";

// ---------- safety: Claude's text is rendered as markdown, never as raw HTML ----------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
marked.use({
  renderer: {
    html(token) { return esc(typeof token === "string" ? token : token.raw || token.text); },
    link(href, title, text) {
      if (typeof href === "object") { text = href.text; title = href.title; href = href.href; }
      const ok = /^https?:\/\//i.test(href || "");
      return ok ? `<a href="${esc(href)}" data-external="1" title="${esc(title || href)}">${text}</a>` : text;
    },
    image(href, title, text) { return esc(typeof href === "object" ? href.text : text || ""); },
  },
});
const md = (text) => marked.parse(text || "");
document.addEventListener("click", (e) => {
  const a = e.target.closest("a");
  if (!a) return;
  e.preventDefault();
  if (a.dataset.external) api().open_url(a.getAttribute("href"));
});

// ---------- helpers ----------
const sameFolder = (a, b) => (!a && !b) || (a && b && a.toLowerCase().replace(/[\\/]+$/, "") === b.toLowerCase().replace(/[\\/]+$/, ""));
const base = (p) => (p || "").split(/[\\/]/).filter(Boolean).pop() || p;
const rel = (p) => { const f = S.active?.cwd; return f && p && p.toLowerCase().startsWith(f.toLowerCase()) ? p.slice(f.length).replace(/^[\\/]/, "") : p; };
function ago(ms) {
  if (!ms) return "";
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "now"; if (s < 3600) return `${Math.floor(s / 60)}m`; if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  return new Date(ms).toLocaleDateString();
}
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

// ---------- events from Python ----------
window.app = {
  events(list) {
    for (const e of list) {
      try { handle(e); } catch (err) { console.error(err, e); }
    }
  },
};
function handle(e) {
  switch (e.kind) {
    case "item":
      if (S.active && e.session === S.active.id) { S.items[e.item.i] = e.item; renderItem(e.item); }
      break;
    case "delta":
      if (S.active && e.session === S.active.id && S.items[e.i]) { S.items[e.i].text += e.text; scheduleRender(e.i); }
      break;
    case "sessions":
      if (sameFolder(e.cwd, S.folder)) { S.sessions = e.sessions; renderSessions(); }
      break;
    case "opened":
      S.active = e.session; S.items = e.items || []; renderTranscript(); renderHead(); renderSessions();
      break;
    case "display": S.display = e; renderState(); break;
    case "levels": S.level = Math.min(1, Math.max(0, (20 * Math.log10((e.levels.at(-1) || 1) / 32768) + 62) / 45)); break;
    case "settings": S.settings = e.settings; renderToggles(); break;
    case "folder": S.folder = e.folder; S.folders = e.folders; renderFolder(); break;
    case "work":
      if (S.active && e.session === S.active.id) { S.active.busy = e.session_state !== "idle"; renderBusy(); }
      break;
  }
}

// ---------- header ----------
function renderFolder() {
  $("#folderBtn").textContent = S.folder ? `▸ ${S.folder}` : "▸ no folder (chat)";
  const code = !!(S.active ? S.active.cwd : S.folder);
  $("#modeBadge").textContent = code ? "CODE" : "CHAT";
  $("#modeBadge").className = "badge " + (code ? "code" : "chat");
}
function renderToggles() {
  $("#tListen").classList.toggle("on", S.settings.listening !== false);
  $("#tVoice").classList.toggle("on", S.settings.voice_replies !== false);
  $("#tPc").classList.toggle("on", !!S.settings.pc_control);
}
function renderState() {
  const st = S.display.state || "idle";
  let label = STATE_LABEL[st] || st;
  if (st === "thinking") label = SPIN[Math.floor(performance.now() / 120) % SPIN.length] + " thinking…";
  $("#stateLabel").textContent = label;
  $("#stateLabel").style.color = MASCOT.colors[st] || "";
}
function animate() {
  MASCOT.draw($("#logo"), S.display.state || "idle", S.level);
  if (S.display.state === "thinking") renderState();
  requestAnimationFrame(animate);
}

$("#folderBtn").onclick = (e) => {
  const items = S.folders.map((f) => [f, () => api().set_folder(f)]);
  showMenu(e.currentTarget, [
    ...items, items.length ? "-" : null,
    ["open folder…", () => api().pick_folder()],
    ["no folder (chat mode)", () => api().set_folder(null)],
  ].filter(Boolean));
};
$("#tListen").onclick = () => api().set_setting("listening", !(S.settings.listening !== false));
$("#tVoice").onclick = () => api().set_setting("voice_replies", !(S.settings.voice_replies !== false));
$("#tPc").onclick = () => api().set_setting("pc_control", !S.settings.pc_control);
$("#compactBtn").onclick = () => api().compact();
$("#logo").onclick = () => api().talk();
$("#panelBtn").onclick = () => { $("#app").classList.toggle("with-panel"); window.panel && panel.refresh(); };

// ---------- sessions ----------
function renderSessions() {
  const list = $("#sessionList");
  list.innerHTML = "";
  const f = S.filter.toLowerCase();
  const shown = S.sessions.filter((s) => !f || (s.title || "").toLowerCase().includes(f) || (s.first || "").toLowerCase().includes(f));
  const section = (title, rows, group) => {
    if (!rows.length && !group) return;
    const h = el("div", "group-title", esc(title));
    if (group) h.oncontextmenu = (e) => { e.preventDefault(); groupMenu(e, group); };
    list.appendChild(h);
    rows.forEach((s) => list.appendChild(sessionRow(s)));
  };
  section("PINNED", shown.filter((s) => s.pinned));
  for (const g of S.groups) section(g.toUpperCase(), shown.filter((s) => !s.pinned && s.group === g), g);
  section(S.folder ? `RECENT · ${base(S.folder)}` : "RECENT CHATS", shown.filter((s) => !s.pinned && !(s.group && S.groups.includes(s.group))));
  if (!shown.length) list.appendChild(el("div", "session m", esc(S.filter ? "no matches" : "no sessions yet")));
}
function sessionRow(s) {
  const row = el("div", "session" + (S.active && S.active.id === s.id ? " active" : ""));
  const src = s.source && s.source !== "yoclaude" ? ` <span class="src">cli</span>` : "";
  row.innerHTML = `<div class="t">${s.busy ? '<span class="busy">✻</span> ' : ""}${esc(s.title)}</div>
    <div class="m">${esc(ago(s.modified))}${s.branch ? " · ⎇ " + esc(s.branch) : ""}${src}</div>`;
  row.title = s.first || s.title;
  row.onclick = () => api().open_session(s.id, s.cwd);
  row.oncontextmenu = (e) => { e.preventDefault(); sessionMenu(e, s); };
  return row;
}
function sessionMenu(e, s) {
  const groups = S.groups.filter((g) => g !== s.group).map((g) => ["  → " + g, () => api().set_group(s.id, s.cwd, g)]);
  showMenu(e, [
    ["rename…", () => ask("Rename session", s.title, (t) => api().rename(s.id, s.cwd, t))],
    [s.pinned ? "unpin" : "pin", () => api().pin(s.id, s.cwd, !s.pinned)],
    "-", ["sub:move to group"], ...groups,
    ["  → new group…", () => ask("New group", "", (g) => api().set_group(s.id, s.cwd, g))],
    s.group ? ["  → no group", () => api().set_group(s.id, s.cwd, null)] : null,
    "-",
    ["fork (branch the conversation)", async () => { const err = await api().fork(s.id, s.cwd); if (err) alertBox(err); }],
    ["move to trash", () => confirmBox(`Move “${s.title}” to the trash? You can restore it from the trash.`,
      async () => { const err = await api().delete(s.id, s.cwd); if (err) alertBox(err); })],
  ].filter(Boolean));
}
function groupMenu(e, g) {
  showMenu(e, [["sub:" + g], ["hide this group (keeps sessions)", () => {
    S.groups = S.groups.filter((x) => x !== g); renderSessions();
  }]]);
}
$("#search").oninput = (e) => { S.filter = e.target.value; renderSessions(); };
$("#newBtn").onclick = () => api().new_session();
$("#newGroupBtn").onclick = () => ask("New group", "", (g) => { if (!S.groups.includes(g)) S.groups.push(g); renderSessions(); });
$("#trashBtn").onclick = async () => {
  const rows = await api().trash();
  const d = dialog("Trash");
  if (!rows.length) d.appendChild(el("div", "dim", "The trash is empty."));
  for (const r of rows) {
    const row = el("div", "trash-row", `<span class="t">${esc(r.title)}</span><span class="dim">${esc(ago(r.deleted * 1000))}</span>`);
    const b = el("button", "", "restore");
    b.onclick = async () => { const err = await api().restore(r.id); if (err) alertBox(err); else row.remove(); };
    row.appendChild(b); d.appendChild(row);
  }
  addButtons(d, [["close", closeModal]]);
};

// ---------- session header: model / effort / permissions ----------
function fillSelect(sel, options, value) {
  sel.innerHTML = options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join("");
  sel.value = value ?? options[0][0];
}
function renderHead() {
  const a = S.active;
  const title = a ? (S.sessions.find((s) => s.id === a.id)?.title || "new session") : "new session";
  $("#sessionTitle").textContent = title + (a?.cwd ? `  ·  ${a.cwd}` : "");
  fillSelect($("#modelSel"), MODELS, a ? a.model : (S.settings.model || ""));
  fillSelect($("#effortSel"), EFFORTS, a ? a.effort : (S.settings.effort || ""));
  fillSelect($("#permSel"), PERMS, a ? a.permission_mode : "default");
  $("#permSel").classList.toggle("hidden", !(a ? a.cwd : S.folder));
  renderFolder(); renderBusy();
}
async function ensureActive() {
  if (!S.active) S.active = await api().new_session();
  return S.active;
}
$("#modelSel").onchange = async (e) => { const a = await ensureActive(); a.model = e.target.value; api().set_model(a.id, e.target.value); };
$("#effortSel").onchange = async (e) => { const a = await ensureActive(); a.effort = e.target.value; api().set_effort(a.id, e.target.value); };
$("#permSel").onchange = async (e) => { const a = await ensureActive(); a.permission_mode = e.target.value; api().set_permission_mode(a.id, e.target.value); };

// ---------- transcript ----------
function renderTranscript() {
  const t = $("#transcript");
  t.innerHTML = ""; itemEls.clear();
  if (!S.items.length) {
    t.appendChild(el("div", "empty", esc(S.active?.cwd
      ? `code session in ${S.active.cwd}\n\nsay “yo claude” or type below`
      : "chat — no folder\n\nsay “yo claude” or type below\npick a folder (top left) for coding")));
  }
  S.items.forEach((it) => it && renderItem(it, true));
  t.scrollTop = t.scrollHeight;
}
function scheduleRender(i) {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; const it = S.items[i]; if (it) renderItem(it); }, 60);
}
function renderItem(it, bulk = false) {
  const t = $("#transcript");
  const nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  t.querySelector(".empty")?.remove();
  const node = buildItem(it);
  const old = itemEls.get(it.i);
  if (old) old.replaceWith(node); else t.appendChild(node);
  itemEls.set(it.i, node);
  node.querySelectorAll("pre code").forEach((c) => { try { hljs.highlightElement(c); } catch (_) {} });
  if (!bulk && nearBottom) t.scrollTop = t.scrollHeight;
}
function buildItem(it) {
  switch (it.kind) {
    case "user": {
      const n = el("div", "msg user"); n.textContent = it.text;
      if (it.voice) n.appendChild(el("span", "mic", "🎤 voice"));
      return n;
    }
    case "assistant": return el("div", "msg assistant" + (it.streaming ? " cursor" : ""), md(it.text));
    case "thinking": {
      const d = el("details", "card"); d.innerHTML = `<summary><span class="st">✻</span><span class="dim">thinking</span></summary>`;
      d.appendChild(el("div", "body msg thinking", esc(it.text))); return d;
    }
    case "tool": return toolCard(it);
    case "approval": return approvalCard(it);
    case "result": {
      const k = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n || 0);
      return el("div", "msg result", esc(`— ${k(it.tokens)} context tokens (${k(it.cached)} cached) · ` +
        `$${(it.cost || 0).toFixed(4)} api-equivalent · ${((it.duration || 0) / 1000).toFixed(1)}s`));
    }
    case "error": return el("div", "msg error", "✗ " + esc(it.text));
  }
  return el("div", "msg dim", esc(JSON.stringify(it)));
}
function toolArg(name, inp) {
  inp = inp || {};
  const p = inp.file_path || inp.notebook_path || inp.path;
  if (name === "Bash") return inp.description || inp.command;
  if (p) return rel(p);
  return inp.pattern || inp.query || inp.url || inp.prompt || inp.description || Object.values(inp).find((v) => typeof v === "string") || "";
}
function diffHtml(oldS, newS) {
  const a = (oldS || "").split("\n"), b = (newS || "").split("\n");
  return `<pre class="diff">${a.map((l) => `<span class="del">- ${esc(l)}</span>`).join("")}${b.map((l) => `<span class="add">+ ${esc(l)}</span>`).join("")}</pre>`;
}
function toolBody(name, inp, result) {
  inp = inp || {};
  let h = "";
  if (name === "Edit") h = diffHtml(inp.old_string, inp.new_string);
  else if (name === "MultiEdit") h = (inp.edits || []).map((e) => diffHtml(e.old_string, e.new_string)).join("");
  else if (name === "Write") h = `<pre>${esc((inp.content || "").slice(0, 6000))}</pre>`;
  else if (name === "Bash") h = `<pre>$ ${esc(inp.command)}</pre>`;
  else h = `<pre>${esc(JSON.stringify(inp, null, 2))}</pre>`;
  if (result) h += `<pre>${esc(result)}</pre>`;
  return h;
}
function toolCard(it) {
  const pc = (it.name || "").startsWith("mcp__screen-control__");
  const name = pc ? "PC · " + it.name.split("__").pop().replace(/_/g, " ") : (it.name || "").replace(/^mcp__/, "");
  const d = el("details", `card ${it.status || "done"}${pc ? " pc" : ""}`);
  const st = { running: "◌", done: "●", error: "✗", denied: "⊘" }[it.status] || "●";
  d.innerHTML = `<summary><span class="st">${st}</span><span class="name">${esc(name)}</span><span class="arg">${esc(toolArg(it.name, it.input))}</span></summary>`;
  const body = el("div", "body", "");
  d.addEventListener("toggle", () => { if (d.open && !body.innerHTML) body.innerHTML = toolBody(it.name, it.input, it.result); });
  d.appendChild(body);
  return d;
}
function approvalCard(it) {
  const n = el("div", "approval " + it.status);
  const head = it.status === "pending" ? "Claude wants to " : it.status === "allowed" ? "✓ allowed: " : "⊘ denied: ";
  n.innerHTML = `<div class="q">${esc(head + it.summary)}</div>`;
  const d = el("details", "card"); d.innerHTML = `<summary><span class="name">${esc(it.tool)}</span><span class="arg">${esc(toolArg(it.tool, it.input))}</span></summary>`;
  d.appendChild(el("div", "body", toolBody(it.tool, it.input)));
  if (it.status === "pending") d.open = true;
  n.appendChild(d);
  if (it.status === "pending") {
    const b = el("div", "btns");
    const sid = S.active.id;
    const btn = (label, cls, allow, always) => { const x = el("button", cls, label); x.onclick = () => api().approve(sid, it.id, allow, always); b.appendChild(x); };
    btn("[allow]", "primary", true, false);
    btn(`[always allow ${it.tool.replace(/^mcp__/, "")} this session]`, "", true, true);
    btn("[deny]", "danger", false, false);
    n.appendChild(b);
  }
  return n;
}
function renderBusy() {
  const busy = !!S.active?.busy;
  $("#stopBtn").classList.toggle("hidden", !busy);
  $("#hint").textContent = busy ? "claude is working — you can queue another message" : "";
}

// ---------- composer ----------
async function send() {
  const box = $("#input");
  const text = box.value.trim();
  if (!text) return;
  box.value = ""; autosize();
  await api().send(text);
}
function autosize() { const b = $("#input"); b.style.height = "auto"; b.style.height = Math.min(200, b.scrollHeight + 2) + "px"; }
$("#input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("#input").addEventListener("input", autosize);
$("#sendBtn").onclick = send;
$("#talkBtn").onclick = () => api().talk();
$("#stopBtn").onclick = () => api().stop();
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.active?.busy) api().stop(); });

// ---------- menus & dialogs ----------
function showMenu(anchor, items) {
  const m = $("#menu");
  m.innerHTML = "";
  for (const it of items) {
    if (it === "-") { m.appendChild(el("hr")); continue; }
    const [label, fn] = it;
    if (label.startsWith("sub:")) { m.appendChild(el("div", "sub", esc(label.slice(4)))); continue; }
    const row = el("div", "", esc(label));
    row.onclick = () => { hideMenu(); fn(); };
    m.appendChild(row);
  }
  m.classList.remove("hidden");
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.clientX, bottom: anchor.clientY };
  m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px";
  m.style.top = Math.min(r.bottom + 2, innerHeight - m.offsetHeight - 8) + "px";
}
function hideMenu() { $("#menu").classList.add("hidden"); }
document.addEventListener("mousedown", (e) => { if (!e.target.closest("#menu")) hideMenu(); });
function dialog(title) {
  const modal = $("#modal");
  modal.innerHTML = ""; modal.classList.remove("hidden");
  const d = el("div", "dialog", `<h3>${esc(title)}</h3>`);
  modal.appendChild(d);
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };
  return d;
}
function closeModal() { $("#modal").classList.add("hidden"); }
function addButtons(d, buttons) {
  const b = el("div", "btns");
  for (const [label, fn, cls] of buttons) { const x = el("button", cls || "", esc(label)); x.onclick = fn; b.appendChild(x); }
  d.appendChild(b);
}
function ask(title, value, done) {
  const d = dialog(title);
  const input = el("input"); input.value = value || ""; d.appendChild(input);
  const ok = () => { const v = input.value.trim(); closeModal(); if (v) done(v); };
  input.onkeydown = (e) => { if (e.key === "Enter") ok(); if (e.key === "Escape") closeModal(); };
  addButtons(d, [["cancel", closeModal], ["ok", ok, "primary"]]);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}
function confirmBox(text, done) {
  const d = dialog("Are you sure?");
  d.appendChild(el("div", "", esc(text)));
  addButtons(d, [["cancel", closeModal], ["yes", () => { closeModal(); done(); }, "danger"]]);
}
function alertBox(text) { const d = dialog("Yo Claude"); d.appendChild(el("div", "", esc(text))); addButtons(d, [["ok", closeModal, "primary"]]); }

// ---------- start ----------
window.addEventListener("pywebviewready", async () => {
  const s = await api().init();
  Object.assign(S, { settings: s.settings, folder: s.folder, folders: s.folders, groups: s.groups, sessions: s.sessions,
                     active: s.active, items: s.items || [], display: s.display });
  renderToggles(); renderFolder(); renderSessions(); renderHead(); renderTranscript(); renderState();
  requestAnimationFrame(animate);
  $("#input").focus();
});
