// /btw: a side chat about the open conversation. Its questions and answers are never added to the conversation
// (Python answers them in a throwaway, unsaved fork of the session: Router.btw_ask), so you can ask something
// quick while Claude works. A small panel over the right side of the transcript; closing it (✕ or Esc) discards it.
"use strict";
window.btw = {
  id: null, session: null, turns: [],   // the open side chat: its id, its session, [{q, a, state, tool}]

  open() { return !$("#btw").classList.contains("hidden"); },
  async ask(question) {
    question = (question || "").trim();
    if (!S.active) return toast("Open a session first.", "error");
    if (!question) { this.show(); $("#btwInput").focus(); return; }
    if (this.session && this.session !== S.active.id) this.close();   // it was about another conversation
    if (this.busy()) return toast("Wait for the side answer first.", "error");
    const sid = this.session = S.active.id;
    this.turns.push({ q: question, a: "", state: "asking" });
    this.show(); this.render();
    const r = await api().btw_ask(sid, question, this.id);
    if (!this.open() || this.session !== sid) {   // closed (Esc) while it was starting: don't leave it running
      if (r?.btw) api().btw_close(sid, r.btw);
      return;
    }
    if (r?.error) { const t = this.turns.at(-1); t.state = "error"; t.a = r.error; this.render(); return; }
    if (this.id && r.btw !== this.id) this.turns = this.turns.slice(-1);   // the old one had ended: a fresh start
    this.id = r.btw;
  },
  busy() { return this.turns.some((t) => t.state === "asking"); },
  // A "btw" event from Python: {session, btw, state: delta|tool|done|error, text}
  event(e) {
    if (e.btw !== this.id || e.session !== this.session) return;
    const t = this.turns.at(-1);
    if (!t) return;
    if (e.state === "delta") { t.a += e.text; t.tool = ""; }
    else if (e.state === "tool") t.tool = e.text;
    else { t.state = e.state; t.a = e.text || t.a; t.tool = ""; }
    this.render();
  },
  show() {
    $("#btw").classList.remove("hidden");
  },
  close() {
    if (this.session) api().btw_close(this.session, this.id);
    this.reset();
    $("#btw").classList.add("hidden");
  },
  reset() { this.id = null; this.session = null; this.turns = []; this.render(); },
  render() {
    const log = $("#btwLog");
    if (!log) return;
    log.innerHTML = this.turns.length ? "" : `<div class="btw-empty">Ask a quick question about this conversation. Claude answers from what's been said and done so far, without interrupting it.</div>`;
    for (const t of this.turns) {
      log.appendChild(el("div", "btw-q", "&gt; " + esc(t.q)));
      const a = el("div", "btw-a" + (t.state === "asking" ? " cursor" : "") + (t.state === "error" ? " error" : ""),
                   t.a ? md(t.a) : (t.state === "asking" ? `<span class="dim">${esc(t.tool ? "⚙ " + t.tool : "✻ thinking…")}</span>` : ""));
      if (t.a && t.tool && t.state === "asking") a.appendChild(el("div", "dim", "⚙ " + esc(t.tool)));
      log.appendChild(a);
    }
    log.scrollTop = log.scrollHeight;
    $("#btwInput").disabled = this.busy();
  },
};
$("#btwBtn").onclick = () => {
  const box = $("#input"), text = box.value.trim().replace(/^\/btw\b\s*/, "");
  if (text && !text.startsWith("/")) { box.value = ""; autosize(); btw.ask(text); }   // what you typed is the question
  else { btw.show(); $("#btwInput").focus(); }
};
$("#btwClose").onclick = () => btw.close();
$("#btwInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); const q = e.target.value; e.target.value = ""; btw.ask(q); }
});
// Esc closes the side chat (before anything else Esc does, such as stopping Claude), unless a dialog,
// the @/slash list or a menu is open: those close first.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !btw.open() || !$("#modal").classList.contains("hidden")) return;
  if (!$("#atlist").classList.contains("hidden") || !$("#menu").classList.contains("hidden")) return;
  e.preventDefault(); e.stopImmediatePropagation();
  btw.close();
}, true);
