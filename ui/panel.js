// Right-hand panel: files / changes / git for the active session's folder, background tasks (tasks.js), and the
// header branch pill.
"use strict";
window.panel = {
  tab: "files", openDirs: new Set([""]), dirs: {}, changes: null, git: null, timer: null,

  shown() { return $("#app").classList.contains("with-panel"); },
  refresh(soon = false) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.load(), soon ? 400 : 0);
  },
  async load() {
    const cwd = S.active ? S.active.cwd : S.folder;
    this.cwd = cwd;
    if (!cwd) { this.git = null; this.changes = null; this.dirs = {}; renderBranch(); if (this.shown()) this.render(); return; }
    const [git, changes] = await Promise.all([api().git_info(), api().changes()]);
    this.git = git; this.changes = changes;
    if (this.shown() && this.tab === "files") await this.loadDirs();
    renderBranch();
    if (this.shown()) this.render();
  },
  async loadDirs() {
    this.dirs = {};
    for (const rel of this.openDirs) this.dirs[rel] = (await api().tree(rel)).entries || [];
  },
  changedMap() {
    const m = new Map();
    const rr = this.changes?.rel_root && this.changes.rel_root !== "." ? this.changes.rel_root.replace(/\\/g, "/") + "/" : "";
    for (const f of this.changes?.files || []) m.set(rr && f.path.startsWith(rr) ? f.path.slice(rr.length) : f.path, f.status);
    return m;
  },

  renderTabs() {
    const p = $("#panel");
    if (!p.querySelector(".ptabs")) return;
    const n = this.changes?.files?.length || 0, running = tasks.running().length;
    p.querySelector(".ptabs .tabs").innerHTML =
      `<button data-t="files" class="${this.tab === "files" ? "on" : ""}">files</button>` +
      `<button data-t="changes" class="${this.tab === "changes" ? "on" : ""}">changes${n ? ` <b>${n}</b>` : ""}</button>` +
      `<button data-t="git" class="${this.tab === "git" ? "on" : ""}">git</button>` +
      `<button data-t="tasks" class="${this.tab === "tasks" ? "on" : ""}${running ? " busy" : ""}" title="Background commands and subagents">` +
      `tasks${running ? ` <b>${running}</b>` : tasks.list.length ? ` <i>${tasks.list.length}</i>` : ""}</button>`;
    p.querySelectorAll("[data-t]").forEach((b) => b.onclick = async () => {
      this.tab = b.dataset.t;
      if (this.tab === "files") await this.loadDirs();
      this.render();
      if (this.tab === "tasks") tasks.poll();
    });
  },
  render() {
    const p = $("#panel");
    p.innerHTML = `<div class="ptabs"><span class="tabs"></span>
      <span class="spacer"></span><button data-act="refresh" title="Refresh">⟳</button></div><div id="pbody"></div>`;
    this.renderTabs();
    p.querySelector("[data-act=refresh]").onclick = () => this.tab === "tasks" ? tasks.poll() : this.load();
    const body = $("#pbody");
    if (this.tab === "tasks") return tasks.render();
    if (!this.cwd) { body.innerHTML = `<div class="pempty">No folder.<br>Pick one at the top left to see files, changes and git.</div>`; return; }
    ({ files: () => this.renderFiles(body), changes: () => this.renderChanges(body), git: () => this.renderGit(body) })[this.tab]();
  },

  // ---------- files ----------
  renderFiles(body) {
    const changed = this.changedMap();
    const head = el("div", "phead", `<span title="${esc(this.cwd)}">${esc(base(this.cwd))}</span><span class="spacer"></span>`);
    const code = el("button", "", "vs code"); code.onclick = () => api().open_in_editor("");
    const rev = el("button", "", "explorer"); rev.onclick = () => api().reveal("");
    head.append(code, rev); body.appendChild(head);
    const tree = el("div", "tree");
    const walk = (rel, depth) => {
      for (const e of this.dirs[rel] || []) {
        const row = el("div", "node" + (e.dir ? " dir" : ""));
        row.style.paddingLeft = 8 + depth * 14 + "px";
        const st = changed.get(e.path);
        const dirChanged = e.dir && [...changed.keys()].some((k) => k.startsWith(e.path + "/"));
        row.innerHTML = `<span class="tw">${e.dir ? (this.openDirs.has(e.path) ? "▾" : "▸") : " "}</span>` +
          `<span class="nm ${st ? "st-" + st : dirChanged ? "st-M" : ""}">${esc(e.name)}</span>${st ? `<span class="badge-st st-${st}">${st}</span>` : ""}`;
        row.onclick = async () => {
          if (e.dir) {
            if (this.openDirs.has(e.path)) this.openDirs.delete(e.path);
            else { this.openDirs.add(e.path); this.dirs[e.path] = (await api().tree(e.path)).entries || []; }
            this.render();
          } else preview(e.path);
        };
        row.oncontextmenu = (ev) => { ev.preventDefault(); fileMenu(ev, e); };
        tree.appendChild(row);
        if (e.dir && this.openDirs.has(e.path)) walk(e.path, depth + 1);
      }
    };
    walk("", 0);
    body.appendChild(tree);
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
    for (const f of c.files) {
      const row = el("div", "node");
      row.innerHTML = `<span class="badge-st st-${f.status}">${f.status}</span><span class="nm">${esc(f.path)}</span>` +
        (c.repo ? `<span class="spacer"></span><span class="add">+${f.add}</span>&nbsp;<span class="del">−${f.del}</span>` : "");
      row.title = f.old ? `renamed from ${f.old}` : f.path;
      row.onclick = () => c.repo ? showDiff(f.path) : preview(f.path);
      list.appendChild(row);
    }
    body.appendChild(list);
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

function fileMenu(ev, e) {
  const attach = ["attach to message", () => composer.attach(e.path)];
  if (!e.dir) return showFileMenu(ev, e.path, panel.cwd, [attach]);
  showMenu(ev, [attach, ["open in vs code", () => api().open_in_editor(e.path)], ["show in explorer", () => api().reveal(e.path)]]);
}

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
