// Plugin buttons (see plugins.py): one per button a plugin's plugin.json declares, loaded at startup and by
// Tools > Reload plugins. Each button's "placement" says where it goes: the header row at the top (default), the menu bar,
// or the composer's row. A plugin that failed to load is reported in a toast, the rest still show.
"use strict";
window.plugins = {
  // Put text in the message box (on a new line if it already holds some) and focus it; nothing is sent.
  compose(text) {
    const box = $("#input");
    if (!box || !text) return;
    box.value = box.value.trim() ? box.value.replace(/\s+$/, "") + "\n" + text : text;
    autosize();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  },
  boxes() {
    return { header: $("#pluginBtnsTop"), menubar: $("#pluginBtnsMenu"), composer: $("#pluginBtns") };
  },
  async load(reload = false) {
    const boxes = this.boxes();
    if (!boxes.header && !boxes.menubar && !boxes.composer) return;
    let r;
    try { r = await (reload ? api().reload_plugins() : api().plugins_list()); } catch (e) { return; }
    for (const box of Object.values(boxes)) box?.replaceChildren();
    const all = [];
    for (const p of r.plugins || []) for (const b of p.buttons) all.push({ p, b });
    all.sort((x, y) => (x.b.order || 0) - (y.b.order || 0));   // stable: ties keep plugin order
    for (const { p, b } of all) {
      const place = boxes[b.placement] ? b.placement : "header";
      const btn = el("button", place === "header" ? "toggle" : "", `[${b.icon ? b.icon + " " : ""}${b.label}]`);
      btn.title = b.tooltip || p.description || `${p.name}: ${b.label}`;
      btn.onclick = async () => {
        if (b.compose) return window.plugins.compose(b.compose);   // nothing to run: just fill the message box
        if (!S.active) return toast("Open a session first.", "error");
        btn.disabled = true;
        try {
          const res = await api().plugin_run(S.active.id, p.name, b.id);
          if (res?.error) toast(res.error, "error");
        } finally { setTimeout(() => { btn.disabled = false; }, 800); }
      };
      boxes[place].appendChild(btn);
    }
    const bad = r.errors || [];
    if (bad.length) toast(`Plugin${bad.length > 1 ? "s" : ""} not loaded: ` + bad.map((x) => `${x.folder} (${x.error})`).join("; "), "error");
    else if (reload) toast(`${(r.plugins || []).length} plugin(s) loaded`);
  },
};
window.addEventListener("pywebviewready", () => window.plugins.load());
