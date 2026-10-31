// Right-hand panel: files / changes / git for the active session's folder, background tasks (tasks.js), and the
// header branch pill.
"use strict";
window.panel = {
  tab: "files", openDirs: new Set([""]), dirs: {}, changes: null, git: null, timer: null,
  // file explorer state: selected paths, Shift-range anchor, copied/cut items, rows in display order
  sel: new Set(), anchor: null, clip: null, visible: [], rows: new Map(), treeFocus: false, dragging: null,
  // browsing: root is the folder the files tab shows (null: the session's own), "::pc" the drives; sorted by name or
  // by modified time
  root: null, session: null, sortKey: "name", sortDir: 1,
  q: { files: "", changes: "", git: "", tasks: "", media: "" }, content: false, searchEls: null, found: null, refocus: null,

  shown() { return $("#app").classList.contains("with-panel"); },
  refresh(soon = false) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), soon ? 400 : 0);
  },
  async load() {
    const session = S.active ? S.active.cwd : S.folder;
    if (!sameFolder(session, this.session)) { this.root = null; this.openDirs = new Set([""]); }   // another session: its folder
    this.session = session;
    const cwd = this.root || session;
    if (!sameFolder(cwd, this.cwd)) { this.sel = new Set(); this.anchor = null; }
    this.cwd = cwd;
    if (!cwd) { this.git = null; this.changes = null; this.dirs = {}; renderBranch(); if (this.shown()) this.render(); return; }
    const [git, changes] = session ? await Promise.all([api().git_info(), api().changes()]) : [null, null];
    this.git = git; this.changes = changes;
    if (this.shown() && this.tab === "files") await this.loadDirs();
    renderBranch();
    if (this.shown()) this.render();
  },
  async loadDirs() {
    const dirs = {};
    for (const rel of [...this.openDirs]) {
      const r = await api().tree(rel, this.cwd);
      if (r.error && rel) { this.openDirs.delete(rel); continue; }   // renamed, moved or deleted
      dirs[rel] = r.entries || [];
    }
    this.dirs = dirs;
    const seen = new Set(Object.values(dirs).flat().map((e) => e.path));
    for (const p of [...this.sel]) if (!seen.has(p)) this.sel.delete(p);
  },
  away() { return !!this.root; },   // browsing somewhere other than the session's folder
  async goTo(path) {   // open a folder in the files tab (null: back to the session's folder)
    this.root = path && !sameFolder(path, this.session) ? path : null;
    this.openDirs = new Set([""]); this.dirs = {}; this.sel = new Set(); this.anchor = null;
    await this.load();
  },
  parentDir(path) {   // the folder above (above a drive's top: the drives)
    if (path === "::pc") return null;
    const p = path.replace(/[\\/]+$/, "");
    if (/^[A-Za-z]:$/.test(p)) return "::pc";
    const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
    return i > 2 ? p.slice(0, i) : p.slice(0, i + 1);
  },
  sorted(list) {   // folders first, then by name or modified time
    const k = this.sortKey, d = this.sortDir;
    return [...list].sort((a, b) => (b.dir - a.dir) || d * (k === "mtime" ? (a.mtime || 0) - (b.mtime || 0)
      : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
  },
  changedMap() {
    const m = new Map();
    if (this.away()) return m;
    const rr = this.changes?.rel_root && this.changes.rel_root !== "." ? this.changes.rel_root.replace(/\\/g, "/") + "/" : "";
    for (const f of this.changes?.files || []) m.set(rr && f.path.startsWith(rr) ? f.path.slice(rr.length) : f.path, f.status);
    return m;
  },

  // ----- search boxes: one on every tab (Ctrl+Shift+F). Files searches the whole folder by name (and inside the files);
  // changes, git, tasks and media filter what's listed -----
  filterBar(key, placeholder, onInput, extras = []) {
    const bar = el("div", "phead psearch"), q = el("input", "pfilter");
    q.dataset.key = key; q.placeholder = placeholder; q.value = this.q[key] || ""; q.spellcheck = false;
    const x = el("button", "pclear", "✕"); x.title = "Clear the search (Esc)";
    const paintX = () => { x.style.visibility = q.value ? "visible" : "hidden"; };
    q.oninput = () => { this.q[key] = q.value; paintX(); onInput(); };
    q.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Escape") { q.value = ""; q.oninput(); } };
    x.onclick = () => { q.value = ""; q.oninput(); q.focus(); };
    paintX();
    bar.append(q, ...extras, x);
    if (this.refocus?.key === key && Date.now() - this.refocus.at < 1000) {   // (the panel was redrawn while you typed: carry on where you were)
      const pos = this.refocus.pos; this.refocus = null;
      setTimeout(() => { q.focus(); q.setSelectionRange(pos, pos); }, 0);
    }
    return bar;
  },
  rememberFocus() {   // call before redrawing a tab
    const f = document.activeElement;
    if (f?.classList?.contains("pfilter")) this.refocus = { key: f.dataset.key, pos: f.selectionStart, at: Date.now() };
  },
  domFilter(root, key) {   // hide the rows that don't have every word you typed
    const terms = (this.q[key] || "").toLowerCase().split(/\s+/).filter(Boolean);
    root.querySelectorAll(".node").forEach((n) => { n.style.display = !terms.length || terms.every((t) => n.textContent.toLowerCase().includes(t)) ? "" : "none"; });
  },
  async runSearch() {   // the files tab: name (and contents) search over the whole folder
    const E = this.searchEls, q = this.q.files.trim();
    if (!E) return;
    E.cols.style.display = E.tree.style.display = q ? "none" : "";
    E.results.style.display = q ? "" : "none";
    if (!q) { E.results.innerHTML = ""; return; }
    clearTimeout(this.searchTimer);
    const run = async () => {
      const key = [this.cwd, q, this.content].join("|"), token = this.searchToken = {};
      if (this.found?.key !== key) {
        E.results.innerHTML = '<div class="pempty">Searching…</div>';
        const r = await api().search_files(q, this.content, this.cwd);
        if (this.searchToken !== token) return;
        this.found = { key, r };
      }
      this.paintResults(E.results, this.found.r);
    };
    this.searchTimer = setTimeout(run, this.found?.key === [this.cwd, q, this.content].join("|") ? 0 : 250);
  },
  paintResults(box, r) {
    box.innerHTML = "";
    if (r?.error) { box.appendChild(el("div", "pempty", esc(r.error))); return; }
    const list = r?.results || [];
    box.appendChild(el("div", "pinfo", list.length ? `${list.length}${r.truncated ? "+" : ""} found${this.content ? "" : ` · tick “in files” to search inside them too`}` : "Nothing found."));
    this.visible = []; this.rows = new Map();
    for (const e of list) {
      const entry = { name: e.name, path: e.path, dir: false, mtime: e.mtime };
      const row = el("div", "node sres"), dir = e.path.includes("/") ? e.path.slice(0, e.path.lastIndexOf("/") + 1) : "";
      row.innerHTML = `<span class="nm">${esc(e.name)}${e.line ? `<span class="dim small"> :${e.line}</span>` : ""}</span><span class="dim small sdir">${esc(dir)}</span>` +
        `<span class="mt" title="${e.mtime ? esc(new Date(e.mtime * 1000).toLocaleString()) : ""}">${shortTime(e.mtime)}</span>` +
        (e.text ? `<div class="stext dim small">${esc(e.text)}</div>` : "");
      row.title = e.path + (e.line ? ` (line ${e.line})` : "");
      row.onclick = (ev) => this.clickRow(ev, entry);
      row.oncontextmenu = (ev) => { ev.preventDefault(); ev.stopPropagation(); if (!this.sel.has(entry.path)) this.select([entry.path], entry.path); fileMenu(ev, entry); };
      this.visible.push(entry); this.rows.set(entry.path + (e.line ? ":" + e.line : ""), row);
      box.appendChild(row);
    }
  },
  renderTabs() {
    const p = $("#panel");
    if (!p.querySelector(".ptabs")) return;
    const n = this.changes?.files?.length || 0, running = tasks.runningHere().length, elsewhere = tasks.runningElsewhere().length;
    const mine = tasks.list.filter((t) => tasks.here(t)).length;
    p.querySelector(".ptabs .tabs").innerHTML =
      `<button data-t="files" class="${this.tab === "files" ? "on" : ""}">files</button>` +
      `<button data-t="changes" class="${this.tab === "changes" ? "on" : ""}">changes${n ? ` <b>${n}</b>` : ""}</button>` +
      `<button data-t="git" class="${this.tab === "git" ? "on" : ""}">git</button>` +
      `<button data-t="media" class="${this.tab === "media" ? "on" : ""}" title="Every screenshot, picture and file in this chat">media${gallery.count ? ` <i>${gallery.count}</i>` : ""}</button>` +
      `<button data-t="tasks" class="${this.tab === "tasks" ? "on" : ""}${running ? " busy" : ""}${tasks.flashUntil > Date.now() ? " pulse" : ""}" title="Background commands and subagents` +
      `${running ? `
${running} running in this session` : ""}${elsewhere ? `
${elsewhere} running in other sessions` : ""}">` +
      `tasks${running ? ` <b>${running}</b>` : mine ? ` <i>${mine}</i>` : ""}${elsewhere ? ` <i class="else">+${elsewhere}</i>` : ""}</button>`;
    p.querySelectorAll("[data-t]").forEach((b) => b.onclick = async () => {
      this.tab = b.dataset.t;
      if (this.tab === "files") await this.loadDirs();
      this.render();
      if (this.tab === "tasks") tasks.poll();
      if (this.tab === "media") gallery.refresh();
    });
  },
  render() {
    const p = $("#panel");
    this.rememberFocus();
    const keepTop = (this.tab === "files" || this.tab === "media") && this.renderedTab === this.tab ? $("#pbody")?.scrollTop || 0 : 0;
    this.renderedTab = this.tab;
    p.innerHTML = `<div class="ptabs"><span class="tabs"></span>
      <span class="spacer"></span><button data-act="refresh" title="Refresh">⟳</button></div><div id="pbody"></div>`;
    this.renderTabs();
    p.querySelector("[data-act=refresh]").onclick = () => this.tab === "tasks" ? tasks.poll() : this.tab === "media" ? gallery.refresh(true) : this.load();
    const body = $("#pbody");
    if (this.tab === "tasks") return tasks.render();
    if (this.tab === "media") { gallery.render(body); if (keepTop) body.scrollTop = keepTop; return; }   // (works without a folder: it's about the chat)
    if (!this.cwd) { body.innerHTML = `<div class="pempty">No folder.<br>Pick one at the top left to see files, changes and git.</div>`; return; }
    ({ files: () => this.renderFiles(body), changes: () => this.renderChanges(body), git: () => this.renderGit(body) })[this.tab]();
    if (keepTop) body.scrollTop = keepTop;
  },

  // ---------- files ----------
  renderFiles(body) {
    const changed = this.changedMap();
    const pc = this.cwd === "::pc";
    const head = el("div", "phead pnav");
    const up = el("button", "", "↑"); up.title = "Up to the folder above (Backspace)"; up.disabled = pc;
    up.onclick = () => this.goTo(this.parentDir(this.cwd));
    const home = el("button", "", "⌂"); home.title = "Back to this session's folder"; home.disabled = !this.away() || !this.session;
    home.onclick = () => this.goTo(null);
    const where = el("input", "pwhere"); where.value = pc ? "This PC" : this.cwd; where.title = "Type or paste a folder and press Enter";
    where.spellcheck = false;
    where.onkeydown = (ev) => {
      if (ev.key === "Enter") { const v = where.value.trim(); this.goTo(/^this pc$/i.test(v) ? "::pc" : v); }
      if (ev.key === "Escape") { where.value = pc ? "This PC" : this.cwd; where.blur(); }
    };
    head.append(up, home, where);
    if (!pc) {
      const code = el("button", "", "vs code"); code.onclick = () => api().open_in_editor("", this.cwd);
      const rev = el("button", "", "explorer"); rev.onclick = () => api().reveal("", this.cwd);
      head.append(code, rev);
    }
    body.appendChild(head);
    const tools = el("div", "phead ftools");
    const tool = (label, title, fn) => { const b = el("button", "", label); b.title = title; b.onclick = fn; tools.appendChild(b); return b; };
    tool("+ file", "New file (in the selected folder, else the top folder)", () => this.newItem(false, this.targetFolder()));
    tool("+ folder", "New folder (in the selected folder, else the top folder)", () => this.newItem(true, this.targetFolder()));
    this.pasteBtn = tool("paste", "Paste copied or cut items (Ctrl+V)", () => this.paste(this.targetFolder()));
    tools.appendChild(el("span", "spacer"));
    tool("⟳", "Refresh the file tree", () => this.load());
    if (!pc) body.appendChild(tools);
    if (!pc) {
      const inFiles = el("button", this.content ? "on" : "", "in files");
      inFiles.title = "Also look inside the files' text (a little slower)";
      inFiles.onclick = () => { this.content = !this.content; inFiles.classList.toggle("on", this.content); this.found = null; this.runSearch(); };
      body.appendChild(this.filterBar("files", "search this folder…  (Ctrl+Shift+F)", () => this.runSearch(), [inFiles]));
    }
    const cols = el("div", "fcols");   // click to sort; again to reverse
    for (const [key, label] of [["name", "name"], ["mtime", "modified"]]) {
      const c = el("button", "fcol " + key + (this.sortKey === key ? " on" : ""), label + (this.sortKey === key ? (this.sortDir > 0 ? " ▲" : " ▼") : ""));
      c.title = key === "mtime" ? "Sort by when it last changed (a folder: its newest file, at any depth)" : "Sort by name";
      c.onclick = () => {
        if (this.sortKey === key) this.sortDir = -this.sortDir; else { this.sortKey = key; this.sortDir = key === "mtime" ? -1 : 1; }
        this.render();
      };
      cols.appendChild(c);
    }
    body.appendChild(cols);
    const tree = el("div", "tree ftree");
    tree.tabIndex = 0;
    this.visible = []; this.rows = new Map();
    const walk = (rel, depth) => {
      for (const e of this.sorted(this.dirs[rel] || [])) {
        const row = el("div", "node" + (e.dir ? " dir" : ""));
        row.style.paddingLeft = 8 + depth * 14 + "px";
        const st = changed.get(e.path);
        const dirChanged = e.dir && [...changed.keys()].some((k) => k.startsWith(e.path + "/"));
        row.innerHTML = `<span class="tw">${e.dir ? (this.openDirs.has(e.path) ? "▾" : "▸") : " "}</span>` +
          `<span class="nm ${st ? "st-" + st : dirChanged ? "st-M" : ""}">${esc(e.name)}</span>${st ? `<span class="badge-st st-${st}">${st}</span>` : ""}` +
          `<span class="mt" title="${e.mtime ? esc(new Date(e.mtime * 1000).toLocaleString()) + (e.approx ? " (or later: too big to look through it all)" : "") : ""}">${shortTime(e.mtime)}${e.approx ? "+" : ""}</span>`;
        row.title = pc ? e.path : e.path + (e.dir ? "\n(double-click to open it here)" : "");
        row.onclick = (ev) => this.clickRow(ev, e);
        if (e.dir) row.ondblclick = (ev) => { ev.preventDefault(); this.goTo(pc ? e.path : this.fullPath(e.path)); };
        row.oncontextmenu = (ev) => {
          ev.preventDefault(); ev.stopPropagation(); this.treeFocus = true;
          if (!this.sel.has(e.path)) this.select([e.path], e.path);
          fileMenu(ev, e);
        };
        this.dragRow(row, e);
        this.visible.push(e); this.rows.set(e.path, row);
        tree.appendChild(row);
        if (e.dir && this.openDirs.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk("", 0);
    tree.onkeydown = (ev) => this.treeKey(ev);
    tree.onfocus = () => { this.treeFocus = true; };
    body.oncontextmenu = (ev) => {   // empty space: the top folder
      if (ev.target.closest(".node") || ev.target.closest("input, button")) return;
      ev.preventDefault(); ev.stopPropagation(); this.treeFocus = true; this.select([]); this.rootMenu(ev);
    };
    body.ondragover = (ev) => { if (!this.dragging || ev.target.closest(".node")) return; ev.preventDefault(); this.dropMark(tree); };
    body.ondrop = (ev) => { if (!this.dragging || ev.target.closest(".node")) return; ev.preventDefault(); ev.stopPropagation(); this.dropOn("", ev.ctrlKey); };
    body.appendChild(tree);
    const results = el("div", "tree ftree sresults");
    body.appendChild(results);
    this.searchEls = pc ? null : { cols, tree, results };
    this.runSearch();
    this.paintSel();
    if (this.treeFocus && $("#modal").classList.contains("hidden")) tree.focus({ preventScroll: true });
  },

  // ---------- file explorer ----------
  parentOf: (p) => p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
  fullPath(rel) { return this.cwd.replace(/[\\/]+$/, "") + (rel ? "\\" + rel.replace(/\//g, "\\") : ""); },
  targets() { return this.visible.filter((e) => this.sel.has(e.path)); },   // selected, in display order
  topLevel(items) {   // drop items whose folder is also selected (deleting/moving the folder covers them)
    const dirs = items.filter((e) => e.dir).map((e) => e.path + "/");
    return items.filter((e) => !dirs.some((d) => e.path.startsWith(d)));
  },
  targetFolder() {   // where new items and pastes go: the selected folder, a selected file's folder, else the top
    const t = this.targets();
    return t.length === 1 ? (t[0].dir ? t[0].path : this.parentOf(t[0].path)) : "";
  },
  clipHere() { return !!(this.clip?.paths.length && sameFolder(this.clip.cwd, this.cwd)); },
  select(paths, anchor) {
    this.sel = new Set(paths);
    if (anchor !== undefined) this.anchor = anchor;
    this.paintSel();
  },
  paintSel() {
    const cut = this.clip?.cut && this.clipHere() ? new Set(this.clip.paths) : null;
    for (const [p, row] of this.rows) {
      row.classList.toggle("sel", this.sel.has(p));
      row.classList.toggle("cut", !!cut?.has(p));
    }
    if (this.pasteBtn) this.pasteBtn.disabled = !this.clipHere();
  },
  openPath(rel) {   // make a folder and its parents open so new things in it show
    for (let p = rel; p; p = this.parentOf(p)) this.openDirs.add(p);
  },
  async toggleDir(e) {
    if (this.openDirs.has(e.path)) {
      this.openDirs.delete(e.path);
      for (const p of [...this.sel]) if (p.startsWith(e.path + "/")) this.sel.delete(p);
    } else { this.openDirs.add(e.path); this.dirs[e.path] = (await api().tree(e.path, this.cwd)).entries || []; }
    this.render();
  },
  clickRow(ev, e) {
    this.treeFocus = true;
    if (ev.ctrlKey || ev.metaKey) {
      this.sel.has(e.path) ? this.sel.delete(e.path) : this.sel.add(e.path);
      this.anchor = e.path; return this.paintSel();
    }
    if (ev.shiftKey && this.anchor) {
      const i = this.visible.findIndex((x) => x.path === this.anchor), j = this.visible.findIndex((x) => x.path === e.path);
      if (i >= 0 && j >= 0) return this.select(this.visible.slice(Math.min(i, j), Math.max(i, j) + 1).map((x) => x.path));
    }
    this.select([e.path], e.path);
    if (e.dir) this.cwd === "::pc" ? this.goTo(e.path) : this.toggleDir(e); else preview(e.path);
  },
  async done(r, selectPaths) {   // after any change: report problems, refresh the tree (open folders kept) and changes
    if (r?.error) toast(r.error, "error");
    if (selectPaths?.length) { this.sel = new Set(selectPaths); this.anchor = selectPaths[0]; }
    this.treeFocus = true;
    await this.load();
  },
  badName(name) {
    if (/[\\/]/.test(name)) { toast("Names can't contain / or \\.", "error"); return true; }
    return false;
  },
  newItem(isDir, folder) {
    ask(`new ${isDir ? "folder" : "file"} in ${folder || base(this.cwd)}`, "", async (name) => {
      if (this.badName(name)) return;
      const r = isDir ? await api().new_folder(folder, name, this.cwd) : await api().new_file(folder, name, this.cwd);
      this.openPath(folder);
      this.done(r, r?.path ? [r.path] : null);
    });
  },
  rename(e) {
    ask(`rename ${e.path}`, e.name, async (name) => {
      if (name === e.name || this.badName(name)) return;
      const r = await api().rename_path(e.path, name, this.cwd);
      if (r?.path && e.dir) {   // keep the folder (and folders inside it) open under the new name
        for (const p of [...this.openDirs]) if (p === e.path || p.startsWith(e.path + "/")) { this.openDirs.delete(p); this.openDirs.add(r.path + p.slice(e.path.length)); }
      }
      this.done(r, r?.path ? [r.path] : null);
    });
    const dot = e.dir ? -1 : e.name.lastIndexOf(".");   // select the name without its extension, like Explorer
    if (dot > 0) setTimeout(() => { const i = $("#modal input"); if (i) i.setSelectionRange(0, dot); }, 10);
  },
  del(items) {
    items = this.topLevel(items);
    if (!items.length) return;
    const names = items.slice(0, 5).map((e) => e.name).join(", ") + (items.length > 5 ? ` and ${items.length - 5} more` : "");
    const what = items.length === 1 ? `"${items[0].name}"${items[0].dir ? " and everything in it" : ""}` : `these ${items.length} items (${names})`;
    confirmBox(`Move ${what} to the Recycle Bin?`, async () => {
      const r = await api().delete_paths(items.map((e) => e.path), this.cwd);
      if (this.clip) this.clip.paths = this.clip.paths.filter((p) => !(r?.paths || []).includes(p));
      this.done(r, []);
    });
  },
  setClip(items, cut) {
    items = this.topLevel(items);
    if (!items.length) return;
    this.clip = { cut, paths: items.map((e) => e.path), cwd: this.cwd };
    this.paintSel();
    toast(`${items.length === 1 ? items[0].name : items.length + " items"} ${cut ? "cut" : "copied"}: paste with Ctrl+V`);
  },
  async paste(dest) {
    if (!this.clip?.paths.length) return toast("Nothing to paste: copy or cut something first.", "error");
    if (!this.clipHere()) return toast("Those were copied in another folder. Copy them again here.", "error");
    const { cut, paths } = this.clip;
    const r = cut ? await api().move_paths(paths, dest, this.cwd) : await api().copy_paths(paths, dest, this.cwd);
    if (cut) this.clip = null;   // a copy can be pasted again (it gets a "(copy 2)" name)
    this.openPath(dest);
    this.done(r, r?.paths);
  },
  async duplicate(items) {
    items = this.topLevel(items);
    if (!items.length) return;
    const r = await api().duplicate_paths(items.map((e) => e.path), this.cwd);
    this.done(r, r?.paths);
  },
  copyPaths(items, relative) {
    const list = items.map((e) => relative ? e.path.replace(/\//g, "\\") : this.fullPath(e.path));
    copyText(list.join("\n"), list.length === 1 ? (relative ? "relative path copied" : "path copied") : `${list.length} paths copied`);
  },

  // drag a selection onto a folder (or empty space for the top folder) to move it; hold Ctrl to copy
  dragRow(row, e) {
    row.draggable = true;
    row.ondragstart = (ev) => {
      if (!this.sel.has(e.path)) this.select([e.path], e.path);
      this.dragging = this.topLevel(this.targets()).map((x) => x.path);
      ev.dataTransfer.setData("text/x-yoclaude-paths", this.dragging.join("\n"));
      ev.dataTransfer.effectAllowed = "copyMove";
    };
    row.ondragend = () => { this.dragging = null; this.dropMark(null); };
    row.ondragover = (ev) => {
      if (!this.dragging) return;   // files dragged in from outside go to the window's own drop (attach)
      ev.preventDefault(); ev.stopPropagation();
      ev.dataTransfer.dropEffect = ev.ctrlKey ? "copy" : "move";
      const dest = e.dir ? e.path : this.parentOf(e.path);
      this.dropMark(dest ? this.rows.get(dest) : row.closest(".ftree"));
    };
    row.ondrop = (ev) => {
      if (!this.dragging) return;
      ev.preventDefault(); ev.stopPropagation();
      this.dropOn(e.dir ? e.path : this.parentOf(e.path), ev.ctrlKey);
    };
  },
  dropMark(node) {
    if (this.dropNode === node) return;
    this.dropNode?.classList.remove("drop");
    this.dropNode = node; node?.classList.add("drop");
  },
  async dropOn(dest, copy) {
    const paths = this.dragging || [];
    this.dragging = null; this.dropMark(null);
    if (!paths.length) return;
    if (!copy && paths.every((p) => this.parentOf(p) === dest)) return;   // dropped where it already is
    const r = copy ? await api().copy_paths(paths, dest, this.cwd) : await api().move_paths(paths, dest, this.cwd);
    this.openPath(dest);
    this.done(r, r?.paths);
  },

  itemMenu(ev, e) {
    const items = this.targets().length ? this.targets() : [e], many = items.length > 1;
    const dest = e.dir ? e.path : this.parentOf(e.path);
    const edit = [
      ["cut", () => this.setClip(items, true), { kbd: "Ctrl+X" }],
      ["copy", () => this.setClip(items, false), { kbd: "Ctrl+C" }],
      [e.dir && !many ? "paste into this folder" : "paste", () => this.paste(dest), { kbd: "Ctrl+V", disabled: !this.clipHere() }],
      ["duplicate", () => this.duplicate(items)],
      ["rename…", () => this.rename(e), { kbd: "F2", disabled: many }],
      ["delete (to Recycle Bin)", () => this.del(items), { kbd: "Del" }],
    ];
    const attach = ["attach to message", () => items.forEach((x) => composer.attach(this.away() ? this.fullPath(x.path) : x.path))];
    const ctx = ["add folder to session context", () => this.addContext(this.cwd === "::pc" ? e.path : this.fullPath(e.path)), { disabled: !S.active }];
    const newHere = [["new file…", () => this.newItem(false, dest)], ["new folder…", () => this.newItem(true, dest)]];
    const relPath = ["copy relative path", () => this.copyPaths(items, true)];
    if (many) return showMenu(ev, [["sub:" + items.length + " items"], attach, "-", ...edit, "-",
      ["copy paths", () => this.copyPaths(items, false)], ["copy relative paths", () => this.copyPaths(items, true)]]);
    if (!e.dir) return showFileMenu(ev, e.path, this.cwd, [attach, ["open in vs code", () => api().open_in_editor(e.path, this.cwd)], "-",
      ...edit, "-", ...newHere, relPath, "-"]);
    if (this.cwd === "::pc") return showMenu(ev, [["sub:" + e.name], ["open", () => this.goTo(e.path)], ctx]);
    showMenu(ev, [["sub:" + e.name], ["open here", () => this.goTo(this.fullPath(e.path))], ctx, "-", attach, ["open in vs code", () => api().open_in_editor(e.path, this.cwd)],
      ["show in explorer", () => api().reveal(e.path, this.cwd)], "-", ...newHere, "-", ...edit, "-",
      ["copy path", () => this.copyPaths(items, false)], relPath]);
  },
  async addContext(path) {   // the open session may also read and write this folder (from your next message)
    const err = await api().add_context_dir(path);
    if (err) alertBox(err); else toast(`Added: ${Who()} can use that folder from your next message`);
  },
  rootMenu(ev) {
    if (this.cwd === "::pc") return;
    showMenu(ev, [["sub:" + base(this.cwd)],
      ...(this.away() ? [["add this folder to session context", () => this.addContext(this.cwd), { disabled: !S.active }], "-"] : []),
      ["new file…", () => this.newItem(false, "")], ["new folder…", () => this.newItem(true, "")],
      ["paste", () => this.paste(""), { kbd: "Ctrl+V", disabled: !this.clipHere() }], "-",
      ["open in vs code", () => api().open_in_editor("", this.cwd)], ["show in explorer", () => api().reveal("", this.cwd)],
      ["copy path", () => copyText(this.fullPath(""), "path copied")], ["refresh", () => this.load()]]);
  },
  treeKey(ev) {
    if (ev.target !== ev.currentTarget) return;
    const k = ev.key, ctrl = (ev.ctrlKey || ev.metaKey) && !ev.altKey, items = this.targets(), one = items.length === 1 ? items[0] : null;
    const act = (fn) => { ev.preventDefault(); ev.stopPropagation(); fn(); };
    if (k === "Backspace" && !ctrl && this.cwd !== "::pc") return act(() => this.goTo(this.parentDir(this.cwd)));
    if (ctrl) {
      const c = k.toLowerCase();
      if (c === "c" && items.length) return act(() => this.setClip(items, false));
      if (c === "x" && items.length) return act(() => this.setClip(items, true));
      if (c === "v") return act(() => this.paste(this.targetFolder()));
      if (c === "a") return act(() => this.select(this.visible.map((e) => e.path)));
      return;
    }
    if (k === "F2" && one) return act(() => this.rename(one));
    if (k === "Delete" && items.length) return act(() => this.del(items));
    if (k === "Enter" && one) return act(() => one.dir ? this.toggleDir(one) : preview(one.path));
    if (k === "Escape" && (this.clip || this.sel.size)) return act(() => { if (this.clip) this.clip = null; else this.sel.clear(); this.paintSel(); });
    if ((k === "ArrowDown" || k === "ArrowUp") && this.visible.length) return act(() => {
      const i = this.visible.findIndex((x) => x.path === this.anchor);
      const j = i < 0 ? 0 : Math.max(0, Math.min(this.visible.length - 1, i + (k === "ArrowDown" ? 1 : -1)));
      const to = this.visible[j].path;
      if (ev.shiftKey) { this.sel.add(to); this.anchor = to; this.paintSel(); } else this.select([to], to);
      this.rows.get(to)?.scrollIntoView({ block: "nearest" });
    });
    if (k === "ArrowRight" && one?.dir && !this.openDirs.has(one.path)) return act(() => this.toggleDir(one));
    if (k === "ArrowLeft" && one) return act(() => {
      if (one.dir && this.openDirs.has(one.path)) return this.toggleDir(one);
      const up = this.parentOf(one.path);
      if (up) { this.select([up], up); this.rows.get(up)?.scrollIntoView({ block: "nearest" }); }
    });
  },

  // ---------- changes ----------
  renderChanges(body) {
    const c = this.changes || {};
    if (c.none) { body.innerHTML = `<div class="pempty">${esc(c.none)}</div>`; return; }
    if (c.error) { body.innerHTML = `<div class="pempty">${esc(c.error)}</div>`; return; }
    const since = c.kind === "start" ? "since this session started" : c.kind === "tools" ? "files Claude's tools changed (not a git repo)" : "since you opened this session";
    body.appendChild(el("div", "phead", `<span>${esc(since)}</span><span class="spacer"></span>` +
      (c.repo ? `<span class="add">+${c.add || 0}</span>&nbsp;<span class="del">−${c.del || 0}</span>` : "")));
    if (!c.files?.length) { body.appendChild(el("div", "pempty", "No changes yet.")); return; }
    const list = el("div", "tree");
    body.appendChild(this.filterBar("changes", "search the changes…", () => this.domFilter(list, "changes")));
    for (const f of c.files) {
      const row = el("div", "node");
      row.innerHTML = `<span class="badge-st st-${f.status}">${f.status}</span><span class="nm">${esc(f.path)}</span>` +
        (c.repo ? `<span class="spacer"></span><span class="add">+${f.add}</span>&nbsp;<span class="del">−${f.del}</span>` : "");
      row.title = f.old ? `renamed from ${f.old}` : f.path;
      row.onclick = () => c.repo ? showDiff(f.path) : preview(f.path);
      list.appendChild(row);
    }
    body.appendChild(list);
    this.domFilter(list, "changes");
  },

  // ---------- git ----------
  renderGit(body) {
    const g = this.git || {};
    if (g.error) { body.innerHTML = `<div class="pempty">${esc(g.error)}</div>`; return; }
    if (!g.repo) { body.innerHTML = `<div class="pempty">Not a git repository.</div>`; return; }
    const sync = g.ahead != null ? ` · ↑${g.ahead} ↓${g.behind}` : " · no upstream";
    body.appendChild(el("div", "phead", `<span>⎇ <b>${esc(g.branch)}</b>${esc(sync)}</span>`));
    body.appendChild(el("div", "pinfo", `${esc(g.head || "")}<br>${g.dirty} changed · ${g.untracked} untracked`));
    const list = el("div", "tree");
    body.appendChild(this.filterBar("git", "search the branches…", () => this.domFilter(list, "git")));
    for (const b of g.branches) {
      const row = el("div", "node" + (b === g.branch ? " cur" : ""));
      row.innerHTML = `<span class="tw">${b === g.branch ? "●" : " "}</span><span class="nm">${esc(b)}</span>`;
      if (b !== g.branch) {
        const sw = el("button", "", "switch");
        sw.onclick = async (ev) => { ev.stopPropagation(); const err = await api().switch_branch(b); if (err) alertBox(err); this.load(); };
        row.appendChild(el("span", "spacer")); row.appendChild(sw);
      }
      list.appendChild(row);
    }
    body.appendChild(list);
    this.domFilter(list, "git");
    const nb = el("div", "phead");
    const input = el("input"); input.placeholder = "new branch name";
    const go = el("button", "primary", "create");
    go.onclick = async () => { const name = input.value.trim(); if (!name) return; const err = await api().create_branch(name); if (err) alertBox(err); this.load(); };
    input.onkeydown = (e) => { if (e.key === "Enter") go.onclick(); };
    nb.append(input, go); body.appendChild(nb);
  },
};

function renderBranch() {
  const g = panel.git, pill = $("#branchPill");
  if (!g || !g.repo) { pill.classList.add("hidden"); return; }
  pill.classList.remove("hidden");
  const n = panel.changes?.files?.length || 0;
  pill.innerHTML = `⎇ ${esc(g.branch)}${g.dirty ? ` <span class="st-M">●${g.dirty}</span>` : ""}${n ? ` · <span class="add">${n} changed</span>` : ""}`;
  pill.title = "Branch, uncommitted files, and files changed in this session. Click for git.";
}
$("#branchPill").onclick = () => { $("#app").classList.add("with-panel"); panel.tab = "git"; panel.load(); };

function fileMenu(ev, e) { panel.itemMenu(ev, e); }   // right-click on a file or folder in the files tab

// The tree keeps keyboard focus across re-renders until you click or tab somewhere else (menus and dialogs don't count).
document.addEventListener("mousedown", (e) => { if (!e.target.closest?.(".ftree, #menu, #modal")) panel.treeFocus = false; });
document.addEventListener("focusin", (e) => { if (!e.target.closest?.(".ftree, #modal")) panel.treeFocus = false; });

function preview(path) {   // images, video, audio and PDFs play; anything else shows as text
  return viewFile(path, panel.cwd, { attach: true });
}

async function showDiff(path) {
  const text = await api().file_diff(path);
  const d = dialog("changes · " + path);
  d.classList.add("wide");
  const pre = el("pre", "viewer diff");
  pre.innerHTML = (text || "(no differences)").split("\n").map((l) => {
    const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") ? "hunk" : "ctx";
    return `<span class="${cls}">${esc(l) || " "}</span>`;
  }).join("");
  d.appendChild(pre);
  addButtons(d, [
    ["revert this file", () => confirmBox(`Put ${path} back the way it was ${panel.changes?.kind === "start" ? "when this session started" : "when you opened this session"}?`,
      async () => { const err = await api().revert_file(path); if (err) alertBox(err); panel.load(); }), "danger"],
    ["open in vs code", () => api().open_in_editor(path)], ["close", closeModal, "primary"]]);
}

// modified and created times (files and media tabs): just the time for today, else the date and the time
function shortTime(t) {
  if (!t) return "";
  const d = new Date(t * 1000), now = new Date(), time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const day = d.getFullYear() === now.getFullYear() ? d.toLocaleDateString([], { day: "numeric", month: "short" })
    : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  return `${day} ${time}`;
}
