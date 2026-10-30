// Drag the edges of the sessions list and the right-hand panel to resize them (double-click puts them back).
"use strict";
const PANES = {
  side: { el: "#side", edge: "right", setting: "side_width", css: "--side-w", min: 180, max: 560, fallback: 260 },
  panel: { el: "#panel", edge: "left", setting: "panel_width", css: "--panel-w", min: 240, max: 900, fallback: 340 },
};
const MIN_CHAT = 520;   // the conversation keeps at least this much
function setPaneWidth(p, w) {
  const other = Object.values(PANES).find((o) => o !== p), otherEl = $(other.el);
  const room = innerWidth - MIN_CHAT - (otherEl.offsetParent ? otherEl.getBoundingClientRect().width : 0);
  w = Math.round(Math.max(p.min, Math.min(p.max, w, room)));
  $("#app").style.setProperty(p.css, w + "px");
  return w;
}
for (const p of Object.values(PANES)) {
  // The grips sit on the window layout, not inside the panes (the right panel rebuilds its contents).
  const pane = $(p.el), grip = el("div", `grip grip-${p.edge}`);
  grip.dataset.tip = "Drag to resize · double-click to reset";
  $("#app").appendChild(grip);
  grip.onpointerdown = (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startX = e.clientX, startW = pane.getBoundingClientRect().width;
    document.body.classList.add("resizing");
    let w = startW;
    grip.onpointermove = (ev) => { w = setPaneWidth(p, startW + (p.edge === "right" ? ev.clientX - startX : startX - ev.clientX)); };
    grip.onpointerup = () => {
      grip.onpointermove = grip.onpointerup = null;
      document.body.classList.remove("resizing");
      if (w !== startW) api().set_setting(p.setting, w);
    };
  };
  grip.ondblclick = () => { setPaneWidth(p, p.fallback); api().set_setting(p.setting, null); };
}
window.addEventListener("pywebviewready", async () => {   // the saved widths (settings arrive with init)
  for (let i = 0; i < 50 && !S.settings?.zoom && !Object.keys(S.settings || {}).length; i++) await new Promise((r) => setTimeout(r, 100));
  for (const p of Object.values(PANES)) if (S.settings?.[p.setting]) setPaneWidth(p, S.settings[p.setting]);
});
