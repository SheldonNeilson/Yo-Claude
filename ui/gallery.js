// The "media" tab in the right-hand panel: every screenshot, picture, video, sound, document and file in the open chat, with
// a preview, name, created and modified dates, in the order they came up in the chat (or by name or date, like the files
// list). Click one to jump to where it is in the chat; click its picture to preview it; right-click for the file menu.
"use strict";
window.gallery = {
  filter: "all", sortKey: "order", sortDir: -1, query: "", count: 0, entries: [], stats: new Map(), busy: false, timer: 0, session: null,
  // ----- what's in the chat -----
  // [{key, i (chat item), ts, via, token|shot, ...}] in chat order: the first time each file or screenshot comes up
  collect() {
    const cwd = S.active?.cwd || "", out = [], seen = new Map();
    const add = (key, e) => {
      const old = seen.get(key);
      if (old) { old.mentions.push(e.i); old.last = e.i; old.lastTs = e.ts; return; }
      const n = { key, mentions: [e.i], last: e.i, lastTs: e.ts, ...e };
      seen.set(key, n); out.push(n);
    };
    const pathsIn = (text) => {
      const t = new Set();
      for (const m of (text || "").match(MEDIA_RE) || []) t.add(m.trim());
      for (const m of (text || "").matchAll(/`([^`\n]{2,200})`/g)) if (looksLikePath(m[1].trim())) t.add(m[1].trim());
      return [...t];
    };
    for (const it of S.items) {
      if (!it) continue;
      if (it.kind === "user") {
        for (const p of it.attachments || []) add("p:" + p, { i: it.i, ts: it.ts, via: "attached by you", token: p });
        for (const p of it.image_paths || []) add("p:" + p, { i: it.i, ts: it.ts, via: "pasted by you", token: p });
        for (const p of pathsIn(it.text)) add("p:" + p, { i: it.i, ts: it.ts, via: "mentioned by you", token: p });
      } else if (it.kind === "assistant" && !it.streaming) {
        for (const p of pathsIn(it.text)) add("p:" + p, { i: it.i, ts: it.ts, via: `mentioned by ${who()}`, token: p });
      } else if (it.kind === "tool") {
        const fp = (it.input || {}).file_path || (it.input || {}).notebook_path, nm = (it.name || "").replace(/^mcp__/, "");
        if (it.image) add("s:" + it.i, { i: it.i, ts: it.ts, via: `screenshot · ${nm.split("__").pop().replace(/_/g, " ")}`, shot: it.image });
        if (fp && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(it.name)) add("p:" + fp, { i: it.i, ts: it.ts, via: it.name === "Write" ? `written by ${who()}` : `edited by ${who()}`, token: fp });
        else if (fp && it.name === "Read" && MEDIA_RE_ONE.test(fp)) add("p:" + fp, { i: it.i, ts: it.ts, via: `looked at by ${who()}`, token: fp });
      }
    }
    return out;
  },
  // find out which of them exist, with their dates and sizes (cached; the refresh button asks again)
  async refresh(force) {
    if (this.busy) return;
    this.busy = true;
    try {
      const cwd = S.active?.cwd || "";
      if (force) this.stats.clear();
      const all = this.collect(), need = [...new Set(all.filter((e) => e.token && !this.stats.has(cwd + "|" + e.token)).map((e) => e.token))];
      for (let k = 0; k < need.length; k += 200) {
        const part = need.slice(k, k + 200), r = (await api().file_stats(part, cwd)) || {};
        for (const t of part) this.stats.set(cwd + "|" + t, r[t] || null);
      }
      const byPath = new Map(), out = [];
      for (const e of all) {
        if (e.shot) { out.push({ ...e, name: e.via, kind: "shot", mtime: e.ts, ctime: e.ts, size: 0 }); continue; }
        const st = this.stats.get(cwd + "|" + e.token);
        if (!st) continue;   // (not a real file: gone, or just a word that looks like one)
        const old = byPath.get(st.path);
        if (old) { old.mentions.push(...e.mentions); old.last = Math.max(old.last, e.last); old.lastTs = e.lastTs || old.lastTs; continue; }
        const n = { ...e, ...st, token: e.token }; byPath.set(st.path, n); out.push(n);
      }
      const sig = out.map((e) => `${e.key}|${e.mentions.length}|${e.mtime}`).join(",");
      this.same = sig === this.sig && this.session === S.active?.id;   // (nothing new: leave the list as it is)
      this.sig = sig; this.entries = out; this.count = out.length; this.session = S.active?.id;
    } finally { this.busy = false; }
    if (panel.tab === "media" && panel.shown() && !(this.same && this.list?.isConnected)) this.render($("#pbody"));
    panel.renderTabs();
  },
  touch() {   // the chat changed: look again soon
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 1200);
  },
  // ----- the tab -----
  sorted(list) {
    const k = this.sortKey, d = this.sortDir;
    return [...list].sort((a, b) => d * (k === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
      : k === "mtime" ? (a.mtime || 0) - (b.mtime || 0) : k === "ctime" ? (a.ctime || 0) - (b.ctime || 0) : a.i - b.i));
  },
  kindOf(e) { return e.kind === "shot" ? "shots" : ["image"].includes(e.kind) ? "pictures" : ["video", "audio"].includes(e.kind) ? "media" : "files"; },
  icon(e) {
    if (e.kind === "dir") return "🗀";
    if (e.kind === "audio") return "♪";
    if (e.kind === "pdf") return "▤";
    return /\.(py|js|ts|tsx|jsx|cs|java|c|cpp|h|go|rs|php|rb|sh|ps1|sql|html|css|json|xml|ya?ml|toml)$/i.test(e.name) ? "‹›" : "▤";
  },
  render(body) {
    if (!body) return;
    const top = body.scrollTop;   // (a re-render must not throw you back to the top)
    body.innerHTML = "";
    if (this.session !== S.active?.id) { body.appendChild(el("div", "pempty", "Looking through the chat…")); this.refresh(); return; }
    const head = el("div", "phead gfilters");
    const kinds = [["all", "all"], ["pictures", "pictures"], ["shots", "screenshots"], ["media", "video & sound"], ["files", "files"]];
    for (const [k, label] of kinds) {
      const n = k === "all" ? this.entries.length : this.entries.filter((e) => this.kindOf(e) === k).length;
      if (!n && k !== "all") continue;
      const b = el("button", "gf" + (this.filter === k ? " on" : ""), `${label} <i>${n}</i>`);
      b.onclick = () => { this.filter = k; this.render(body); };
      head.appendChild(b);
    }
    head.appendChild(el("span", "spacer"));
    const rf = el("button", "", "⟳"); rf.title = "Look through the chat again (and re-read the files' dates)"; rf.onclick = () => this.refresh(true);
    head.appendChild(rf);
    body.appendChild(head);
    panel.rememberFocus();
    body.appendChild(panel.filterBar("media", "search the media…  (Ctrl+Shift+F)", () => { this.query = panel.q.media; this.paintList(); }));
    this.query = panel.q.media;
    const cols = el("div", "fcols gcols");   // click to sort; again to reverse (the same columns as the rows below)
    for (const [key, label, tip] of [["order", "chat", "In the order they came up in the chat"], ["name", "name", "Sort by name"],
      ["mtime", "modified", "Sort by when the file last changed"], ["ctime", "created", "Sort by when the file was made"]]) {
      const c = el("button", "fcol gcol" + (this.sortKey === key ? " on" : ""), label + (this.sortKey === key ? (this.sortDir > 0 ? " ▲" : " ▼") : ""));
      c.title = tip;
      c.onclick = () => {
        if (this.sortKey === key) this.sortDir = -this.sortDir; else { this.sortKey = key; this.sortDir = key === "name" ? 1 : -1; }
        this.render(body);
      };
      cols.appendChild(c);
    }
    body.appendChild(cols);
    this.list = el("div", "glist");
    body.appendChild(this.list);
    this.paintList();
    body.scrollTop = top;
  },
  paintList() {
    const list = this.list;
    if (!list) return;
    list.innerHTML = "";
    const q = this.query.trim().toLowerCase();
    const rows = this.sorted(this.entries.filter((e) => (this.filter === "all" || this.kindOf(e) === this.filter) && (!q || e.name.toLowerCase().includes(q))));
    if (!rows.length) {
      list.appendChild(el("div", "pempty", this.entries.length ? "Nothing matches." : "No screenshots, pictures or files in this chat yet."));
      return;
    }
    for (const e of rows) list.appendChild(this.row(e));
  },
  row(e) {
    const r = el("div", "grow"), th = el("div", "gthumb"), info = el("div", "ginfo");
    if (e.kind === "shot") { const img = el("img"); img.src = e.shot; img.loading = "lazy"; th.appendChild(img); }
    else if (e.kind === "image" && e.url) { const img = el("img"); img.src = e.url; img.loading = "lazy"; th.appendChild(img); }
    else if (e.kind === "video" && e.url) { const v = el("video"); v.src = e.url + "#t=0.5"; v.preload = "metadata"; v.muted = true; th.appendChild(v); th.classList.add("vid"); }
    else { th.textContent = this.icon(e); th.classList.add("ico"); }
    th.title = "Preview";
    th.onclick = (ev) => { ev.stopPropagation(); this.preview(e); };
    const size = e.size ? ` · ${this.size(e.size)}` : "";
    info.innerHTML = `<div class="gname">${esc(e.name)}</div>` +
      `<div class="gvia faint small">${esc(e.via)}${e.mentions.length > 1 ? ` · ${e.mentions.length}×` : ""}${esc(size)}</div>`;
    const date = (t) => el("div", "gdate dim small", t ? esc(shortTime(t)) : "");   // (a screenshot has no file: its time is under "modified")
    const dm = date(e.mtime), dc = date(e.kind === "shot" ? 0 : e.ctime);
    if (e.kind !== "shot") {
      dm.title = `modified ${new Date(e.mtime * 1000).toLocaleString()}`; dc.title = `created ${new Date(e.ctime * 1000).toLocaleString()}`;
    } else dm.title = `seen ${new Date(e.ts * 1000).toLocaleString()}`;
    r.append(th, info, dm, dc);
    r.title = (e.path || e.name) + "\nClick: jump to it in the chat · picture: preview · right-click: more";
    r.onclick = () => this.jump(e);
    r.oncontextmenu = (ev) => this.menu(ev, e);
    return r;
  },
  size(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(0) + " KB" : (n / 1048576).toFixed(1) + " MB"; },
  preview(e) {
    if (e.kind === "shot") return showPicture(e.shot, e.name);
    if (e.kind === "dir") return api().open_path(e.path, "open");
    viewFile(e.path, S.active?.cwd);
  },
  // scroll the chat to where it came up (the latest mention; again to go back through the earlier ones) and flash it
  jump(e) {
    const at = e.mentions.filter((i, n, a) => a.indexOf(i) === n);
    const k = at.indexOf(this.lastJump?.key === e.key ? this.lastJump.i : -1);
    const i = this.lastJump?.key === e.key && k > 0 ? at[k - 1] : at[at.length - 1];
    this.lastJump = { key: e.key, i };
    let node = transcript.els.get(i);
    if (!node) {   // a step Claude took (a file it wrote, a screenshot): inside a group of steps, folded away until opened
      const g = transcript.groupOf.get(i);
      if (g) {
        if (!g.open) { g.open = true; g.steps.classList.remove("hidden"); transcript.renderHead(g); }
        node = g.stepEls.get(i);
        if (node && node.tagName === "DETAILS") node.open = true;
      }
    }
    if (!node) { toast("That part of the chat isn't shown."); return; }
    for (let d = node.parentElement; d; d = d.parentElement) if (d.tagName === "DETAILS") d.open = true;
    follow.set("chat", false);   // (so the chat stays where it was put)
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.remove("jumpflash"); void node.offsetWidth; node.classList.add("jumpflash");
    setTimeout(() => node.classList.remove("jumpflash"), 2600);
  },
  rel(e) {   // the path inside the session's folder (to attach it or show it in the files tab), or null
    const cwd = (S.active?.cwd || "").replace(/\\/g, "/").replace(/\/$/, ""), p = (e.path || "").replace(/\\/g, "/");
    return cwd && p.toLowerCase().startsWith(cwd.toLowerCase() + "/") ? p.slice(cwd.length + 1) : null;
  },
  async showInFiles(rel) {
    panel.tab = "files"; panel.openPath(panel.parentOf(rel)); await panel.load();
    panel.select([rel], rel);
    const row = panel.rows.get(rel);
    if (row) { row.scrollIntoView({ block: "center" }); row.classList.add("flash"); setTimeout(() => row.classList.remove("flash"), 2000); }
  },
  menu(ev, e) {
    const here = [["go to it in the chat", () => this.jump(e)]];
    if (e.kind === "shot") {
      showMenu(ev, [...here, ["view larger", () => this.preview(e)]]);
      ev.preventDefault(); ev.stopPropagation();
      return;
    }
    const rel = this.rel(e);
    here.push(["sub:in the chat"]);
    if (rel) {
      here.push(["show in the files tab", () => this.showInFiles(rel)]);
      if (e.kind !== "dir") here.push(["attach to the next message", () => composer.attach(rel)]);
    }
    if (e.kind === "dir") {
      ev.preventDefault(); ev.stopPropagation();
      return showMenu(ev, [...here, ["open in explorer", () => api().open_path(e.path, "open")], ["open in vs code", () => api().open_path(e.path, "code")],
        ...termMenuItems(e.path, null, "dir"), ["copy path", () => copyText(e.path, "path copied")]]);
    }
    showFileMenu(ev, e.path, S.active?.cwd, here);
  },
};
