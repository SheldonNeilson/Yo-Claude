// The writing models window (Options › Writing › Models…): which model does AutoCorrect and which does the grey word
// prediction: Haiku (the default) or one running on this PC through Ollama or any OpenAI-compatible server. Lists the
// models on offer with their state (download, test, delete), and adds your own. localai.py is the other half.
"use strict";
window.models = {
  info: null, progress: {}, dlg: null,
  async load() { this.info = await api().models_info(); return this.info; },
  name(id) {
    if (!id || id === "haiku") return "Haiku";
    return this.info?.models.find((m) => m.id === id)?.label || "a local model";
  },
  async open() {
    await this.load();
    this.dlg = dialog("Writing models");
    this.paint();
  },
  event(e) {   // a download's progress
    this.progress[e.id] = e;
    if (e.done) {
      delete this.progress[e.id];
      if (e.error) alertBox(e.error);
      else toast("downloaded");
      this.load().then(() => this.paint());
    } else if (this.dlg && !$("#modal").classList.contains("hidden")) {
      const b = this.dlg.querySelector(`[data-dl="${e.id}"]`);
      if (b) b.textContent = e.pct != null ? `downloading… ${e.pct}%` : (e.status || "downloading…");
    }
  },
  paint() {
    const d = this.dlg, I = this.info;
    if (!d || $("#modal").classList.contains("hidden")) return;
    d.querySelectorAll(":scope > :not(h3)").forEach((x) => x.remove());
    d.appendChild(el("p", "dim small", "AutoCorrect and the grey word prediction can use <b>Haiku</b> (the default: quick, and uses a little of " +
      "your Claude allowance) or a model on this PC: private, free and it works offline. A small one is best for typing."));
    const oll = I.ollama.up ? "Ollama is running." : I.ollama.installed ? "Ollama is installed (it starts when a model is used)."
      : "Ollama isn't installed: it runs the models, and it's a small free installer.";
    const line = el("p", "dim small", esc(oll) + " ");
    if (!I.ollama.installed) {
      const a = el("button", "", "get Ollama"); a.onclick = () => api().open_url("https://ollama.com/download"); line.appendChild(a);
    }
    d.appendChild(line);
    const usable = I.models.filter((m) => m.installed);
    for (const [key, label] of [["fix_model", "AutoCorrect uses"], ["predict_model", "Predictions use"]]) {
      const row = el("div", "mrow"), sel = el("select");
      sel.innerHTML = `<option value="haiku">Haiku (default)</option>` + usable.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}${m.huge ? " (big: slow)" : ""}</option>`).join("");
      sel.value = usable.some((m) => m.id === I[key]) ? I[key] : "haiku";
      sel.onchange = () => { I[key] = sel.value; api().set_setting(key, sel.value); };
      row.append(el("span", "mlabel", label), sel);
      d.appendChild(row);
    }
    d.appendChild(el("h4", "", "Models on this PC"));
    for (const m of I.models) {
      const row = el("div", "mrow mlist");
      row.appendChild(el("span", "mname", `${esc(m.label)} <span class="dim small">${esc(m.size || "")}${m.builtin && m.id === "qwen2.5-1.5b" ? " · suggested" : ""}${m.backend === "openai" ? " · " + esc(m.url) : ""}</span>`));
      const btns = el("span", "mbtns");
      const add = (t, fn, cls) => { const b = el("button", cls || "", t); b.onclick = fn; btns.appendChild(b); return b; };
      if (this.progress[m.id]) add("downloading…", () => {}).dataset.dl = m.id;
      else if (!m.installed) add("download", () => { api().model_pull(m.id); this.progress[m.id] = { id: m.id }; this.paint(); }, "primary").dataset.dl = m.id;
      else {
        add("test", async (ev) => {
          ev.target.textContent = "…";
          const r = await api().model_test(m.id);
          ev.target.textContent = r.error ? "failed" : `${r.ms} ms`;
          if (r.error) alertBox(r.error); else toast(`“…take a look at the ${r.text || "(nothing)"}”  ·  ${r.ms} ms`);
        });
        if (m.backend === "ollama") add("delete", () => confirmBox(`Delete ${m.label} from this PC?`, async () => {
          const r = await api().model_delete(m.id); if (r.error) alertBox(r.error);
          await this.load(); this.paint();
        }));
      }
      if (!m.builtin && !m.found) add("remove", async () => { await api().model_remove(m.id); await this.load(); this.paint(); });
      row.appendChild(btns);
      d.appendChild(row);
    }
    const bar = el("div", "btns");
    const addBtn = el("button", "", "+ add a model…"); addBtn.onclick = () => this.add();
    const done = el("button", "primary", "done"); done.onclick = closeModal;
    bar.append(addBtn, done);
    d.appendChild(bar);
  },
  add() {
    const d = dialog("Add a local model");
    d.appendChild(el("p", "dim small", "Type an <b>Ollama</b> model name (like <code>llama3.2:3b</code>; you can then download it here), or, " +
      "for LM Studio, llama.cpp's server or anything with an OpenAI-style API, fill in its address too."));
    const f = (label, ph) => { const w = el("div", "mrow"); const i = el("input"); i.placeholder = ph; w.append(el("span", "mlabel", label), i); d.appendChild(w); return i; };
    const name = f("model", "llama3.2:3b"), url = f("server", "blank for Ollama, or http://localhost:1234/v1"), label = f("name", "optional");
    const go = async () => {
      const r = await api().model_add(url.value.trim() ? "openai" : "ollama", name.value, url.value, label.value);
      if (r.error) return alertBox(r.error);
      await this.load(); this.dlg = dialog("Writing models"); this.paint();
    };
    d.onkeydown = (e) => { if (e.key === "Enter") go(); };
    addButtons(d, [["cancel", () => this.open()], ["add", go, "primary"]]);
    name.focus();
  },
};
