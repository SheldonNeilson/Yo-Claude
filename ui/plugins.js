// Plugin buttons on the composer's row (see plugins.py): one per button a plugin's plugin.json declares, loaded at
// startup and by Tools > Reload plugins. A plugin that failed to load is reported in a toast, the rest still show.
"use strict";
window.plugins = {
  async load(reload = false) {
    const box = $("#pluginBtns");
    if (!box) return;
    let r;
    try { r = await (reload ? api().reload_plugins() : api().plugins_list()); } catch (e) { return; }
    box.replaceChildren();
    for (const p of r.plugins || []) for (const b of p.buttons) {
      const btn = el("button", "", `[${b.icon ? b.icon + " " : ""}${b.label}]`);
      btn.title = b.tooltip || p.description || `${p.name}: ${b.label}`;
      btn.onclick = async () => {
        if (!S.active) return toast("Open a session first.", "error");
        btn.disabled = true;
        try {
          const res = await api().plugin_run(S.active.id, p.name, b.id);
          if (res?.error) toast(res.error, "error");
        } finally { setTimeout(() => { btn.disabled = false; }, 800); }
      };
      box.appendChild(btn);
    }
    const bad = r.errors || [];
    if (bad.length) toast(`Plugin${bad.length > 1 ? "s" : ""} not loaded: ` + bad.map((x) => `${x.folder} (${x.error})`).join("; "), "error");
    else if (reload) toast(`${(r.plugins || []).length} plugin(s) loaded`);
  },
};
window.addEventListener("pywebviewready", () => window.plugins.load());
