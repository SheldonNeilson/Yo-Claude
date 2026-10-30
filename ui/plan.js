// Claude's plan for the current task (its TodoWrite / TaskCreate / TaskUpdate calls) as a retro checklist above
// the message box: what's done, what it's doing now, what's next.
"use strict";
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate"]);
window.planBox = {
  collapsed: null,   // null: decide by itself (folded once everything's done)

  isPlanItem(it) { return it && it.kind === "tool" && PLAN_TOOLS.has(it.name); },
  // The plan as it stands after the last of those calls in the conversation.
  current() {
    let steps = [], seen = false;
    for (const it of S.items) {
      if (!this.isPlanItem(it)) continue;
      seen = true;
      const inp = it.input || {};
      if (it.name === "TodoWrite") {
        steps = (inp.todos || []).map((t, n) => ({ id: String(n + 1), text: t.content, active: t.activeForm, status: t.status }));
      } else if (it.name === "TaskCreate") {
        const id = (String(it.result || "").match(/#(\d+)/) || [])[1] || String(steps.length + 1);
        steps.push({ id, text: inp.subject || inp.description, active: inp.activeForm, status: "pending" });
      } else if (it.name === "TaskUpdate") {
        const s = steps.find((x) => x.id === String(inp.taskId));
        if (!s) continue;
        if (inp.status === "deleted") steps = steps.filter((x) => x !== s);
        else Object.assign(s, inp.status ? { status: inp.status } : {}, inp.subject ? { text: inp.subject } : {},
                           inp.activeForm ? { active: inp.activeForm } : {});
      }
    }
    return seen ? steps : null;
  },
  update() {
    const box = $("#planBox"), steps = S.active ? this.current() : null;
    if (!steps || !steps.length) { box.classList.add("hidden"); return; }
    const done = steps.filter((s) => s.status === "completed").length, all = done === steps.length;
    const folded = this.collapsed ?? all;
    const now = steps.find((s) => s.status === "in_progress");
    box.classList.remove("hidden");
    box.classList.toggle("folded", folded);
    box.innerHTML = `<div class="planhead"><span class="tw">${folded ? "▸" : "▾"}</span><b>PLAN</b>` +
      `<span class="planbar">${steps.map((s) => `<i class="${s.status}"></i>`).join("")}</span>` +
      `<span class="dim">${done}/${steps.length} done</span>` +
      (folded && now ? `<span class="plannow">» ${esc(now.active || now.text)}</span>` : "") +
      (all ? '<span class="add">✓ all done</span>' : "") + "</div>";
    if (!folded) {
      const list = el("div", "planlist");
      for (const s of steps) {
        const mark = s.status === "completed" ? "[x]" : s.status === "in_progress" ? `[${SPIN[Math.floor(Date.now() / 120) % SPIN.length]}]` : "[ ]";
        list.appendChild(el("div", "planstep " + s.status,
          `<span class="pm">${mark}</span><span>${esc(s.status === "in_progress" && s.active ? s.active : s.text)}</span>`));
      }
      box.appendChild(list);
    }
    box.querySelector(".planhead").onclick = () => { this.collapsed = !folded; this.update(); };
  },
};
// The spinner on the step in progress turns while Claude works.
setInterval(() => { if (S.active?.busy && !$("#planBox").classList.contains("hidden")) planBox.update(); }, 360);
