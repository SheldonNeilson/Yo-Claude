// Context window and plan usage-limit meters, their detail views, and quick tooltips for anything with data-tip.
"use strict";
const fmtTok = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : n >= 1000 ? (n / 1000).toFixed(n >= 1e4 ? 0 : 1) + "k" : String(n || 0);
const meterLevel = (pct) => pct >= 80 ? "hi" : pct >= 50 ? "mid" : "lo";
function resetIn(ts) {
  if (!ts) return "";
  const ms = ts * 1000 - Date.now();
  if (ms <= 0) return "resetting now";
  const h = Math.floor(ms / 3600e3), m = Math.floor(ms / 60e3) % 60, at = new Date(ts * 1000);
  const when = h >= 24 ? at.toLocaleDateString(undefined, { weekday: "short" }) + " " + at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                       : at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `resets in ${h >= 24 ? Math.floor(h / 24) + "d " + (h % 24) + "h" : h ? `${h}h ${m}m` : `${m}m`} (${when})`;
}
const WINDOW_NAMES = { five_hour: ["5h", "5-hour session limit"], seven_day: ["7d", "Weekly limit (all models)"],
  seven_day_opus: ["7d Opus", "Weekly Opus limit"], seven_day_sonnet: ["7d Sonnet", "Weekly Sonnet limit"], overage: ["extra", "Extra usage"] };
const since = (ms) => { const a = ago(ms); return a === "now" ? "just now" : a + " ago"; };
const meterBar = (pct, cls = "") => `<span class="mbar ${cls} ${meterLevel(pct)}"><span style="width:${Math.min(100, pct)}%"></span></span>`;

// ---------- context window (per session, in the session header) ----------
function renderContext() {
  const m = $("#ctxMeter"), c = S.active?.context;
  m.classList.toggle("hidden", !S.active);
  if (!S.active) return;
  if (!c) {
    m.innerHTML = `ctx ${meterBar(0)} <span class="dim">—</span>`;
    m.dataset.tip = "Context window\nMeasured after the next reply in this session.";
    return;
  }
  const pct = c.percentage || 0;
  m.innerHTML = `ctx ${meterBar(pct)} <b class="${meterLevel(pct)}">${Math.round(pct)}%</b>`;
  m.dataset.tip = `Context window: ${fmtTok(c.total)} of ${fmtTok(c.max)} tokens (${pct.toFixed(1)}%)` +
    (c.autocompact ? `\nAuto-compacts near ${fmtTok(c.autocompact)}` : "") + "\nClick for the breakdown";
}
const CAT_COLORS = ["#d97757", "#e8b04b", "#9fd17f", "#5ab0ff", "#b9a3ff", "#ff8c60", "#7fd1c7", "#c58cff", "#e88fb4"];
function showContext() {
  const c = S.active?.context;
  const d = dialog("Context window");
  d.classList.add("wide", "ctxview");
  if (!c) { d.appendChild(el("div", "dim", "Not measured yet: it's measured after each reply in this session.")); addButtons(d, [["close", closeModal, "primary"]]); return; }
  const cats = c.categories.filter((x) => x.tokens > 0);
  let seg = "", i = 0;
  for (const x of cats) {
    const free = /free space/i.test(x.name);
    seg += `<span title="${esc(x.name)}: ${fmtTok(x.tokens)}" style="width:${(100 * x.tokens / c.max).toFixed(2)}%;background:${free ? "transparent" : CAT_COLORS[i++ % CAT_COLORS.length]}"></span>`;
  }
  i = 0;
  const rows = cats.map((x) => {
    const free = /free space/i.test(x.name), color = free ? "var(--faint)" : CAT_COLORS[i++ % CAT_COLORS.length];
    return `<tr><td><span class="sw" style="background:${color}"></span>${esc(x.name)}${x.deferred ? ' <span class="dim">(loaded when needed)</span>' : ""}</td>` +
           `<td class="num">${fmtTok(x.tokens)}</td><td class="num dim">${(100 * x.tokens / c.max).toFixed(1)}%</td></tr>`;
  }).join("");
  const b = c.breakdown || {};
  const msgRows = [["your messages", b.userMessageTokens], ["Claude's replies", b.assistantMessageTokens], ["tool calls", b.toolCallTokens],
                   ["tool results", b.toolResultTokens], ["attachments", b.attachmentTokens]].filter(([, v]) => v)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${fmtTok(v)}</td></tr>`).join("");
  const mcp = (c.mcp || []).filter((t) => t.tokens).map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${fmtTok(t.tokens)}</td></tr>`).join("");
  const mem = (c.memory || []).filter((t) => t.tokens).map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${fmtTok(t.tokens)}</td></tr>`).join("");
  const tips = [];
  if (c.percentage >= 60) tips.push("It's getting full: replies get slower and costlier. Compact it, or start a new session (Ctrl+N).");
  const pcTok = (c.mcp || []).filter((t) => /screen-control/.test(t.server || t.name)).reduce((a, t) => a + t.tokens, 0);
  if (pcTok > 2000) tips.push(`PC control's tools take about ${fmtTok(pcTok)} here. Turn it off in the Voice menu when you don't need it.`);
  if ((b.toolResultTokens || 0) > c.total * 0.4) tips.push("Most of it is tool results (files read, command output, screenshots).");
  d.appendChild(el("div", "", `<p><b>${fmtTok(c.total)}</b> of ${fmtTok(c.max)} tokens used (<b class="${meterLevel(c.percentage)}">${c.percentage.toFixed(1)}%</b>)` +
    `<span class="dim"> · ${esc(c.model || "")}${c.autocompact ? ` · auto-compacts near ${fmtTok(c.autocompact)}` : ""}</span></p>` +
    `<div class="stack">${seg}</div>` +
    `<div class="ctxcols"><table class="ctxtab">${rows}</table>` +
    `<div>${msgRows ? `<h4>conversation</h4><table class="ctxtab">${msgRows}</table>` : ""}` +
    `${mcp ? `<h4>biggest MCP tools</h4><table class="ctxtab">${mcp}</table>` : ""}` +
    `${mem ? `<h4>memory files</h4><table class="ctxtab">${mem}</table>` : ""}</div></div>` +
    (tips.length ? `<ul class="tips">${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : "")));
  addButtons(d, [["compact this conversation", () => { closeModal(); api().send("/compact"); }],
                 ["new session", () => { closeModal(); api().new_session(); }], ["close", closeModal, "primary"]]);
}
$("#ctxMeter").onclick = showContext;

// ---------- plan usage limits (account-wide, in the menu bar) ----------
function renderLimits(l) {
  if (l !== undefined) S.limits = l;
  l = S.limits;
  const m = $("#limitsMeter");
  const wins = Object.entries(l?.windows || {}).filter(([, w]) => w.utilization != null);
  m.classList.toggle("hidden", !wins.length);
  if (!wins.length) return;
  m.innerHTML = wins.filter(([k]) => k === "five_hour" || k === "seven_day").map(([k, w]) => {
    const pct = 100 * w.utilization;
    return `<span class="lim">${esc(WINDOW_NAMES[k]?.[0] || k)} ${meterBar(pct)} <b class="${meterLevel(pct)}">${Math.round(pct)}%</b></span>`;
  }).join("");
  m.dataset.tip = wins.map(([k, w]) => `${WINDOW_NAMES[k]?.[1] || k}: ${Math.round(100 * w.utilization)}% used, ${resetIn(w.resets_at)}`).join("\n") +
    `\nUpdated ${since(l.updated * 1000)} · click for details`;
  m.classList.toggle("warn", l.status && l.status !== "allowed");
}
function showLimits() {
  const l = S.limits;
  const d = dialog("Usage limits");
  d.classList.add("limview");
  if (!l) { d.appendChild(el("div", "dim", "Not known yet: they're reported with each reply.")); addButtons(d, [["close", closeModal, "primary"]]); return; }
  const status = { allowed: "within your limits", allowed_warning: "close to a limit", rejected: "limit reached: replies are paused until it resets" }[l.status] || l.status;
  d.appendChild(el("div", "", `<p>Your Claude plan's limits, shared by everything using your account (Yo Claude, Claude Code, the Claude app).
    Status: <b class="${l.status === "allowed" ? "lo" : l.status === "rejected" ? "hi" : "mid"}">${esc(status)}</b>.</p>` +
    Object.entries(l.windows || {}).map(([k, w]) => {
      const pct = w.utilization != null ? 100 * w.utilization : null;
      return `<div class="limrow"><div class="limname">${esc(WINDOW_NAMES[k]?.[1] || k)}</div>` +
        (pct != null ? `${meterBar(pct, "big")} <b class="${meterLevel(pct)}">${pct.toFixed(0)}%</b>` : '<span class="dim">no figure</span>') +
        `<div class="dim small">${esc(resetIn(w.resets_at))}</div></div>`;
    }).join("") +
    `<p class="dim small">Extra usage beyond the plan: ${l.using_overage ? "<b>in use</b>" : esc(l.overage === "rejected" ? "off" : l.overage || "—")}` +
    `${l.overage_reason ? ` (${esc(l.overage_reason.replace(/_/g, " "))})` : ""}. Updated ${esc(since(l.updated * 1000))}, with the latest reply.</p>`));
  addButtons(d, [["close", closeModal, "primary"]]);
}
$("#limitsMeter").onclick = showLimits;
setInterval(() => renderLimits(), 60000);   // keep "resets in" fresh

// ---------- quick, multi-line tooltips for anything with data-tip ----------
const tipEl = el("div", "tip hidden");
document.body.appendChild(tipEl);
let tipTimer = null;
document.addEventListener("mouseover", (e) => {
  const t = e.target.closest("[data-tip]");
  clearTimeout(tipTimer);
  if (!t) return tipEl.classList.add("hidden");
  tipTimer = setTimeout(() => {
    tipEl.textContent = t.dataset.tip;
    tipEl.classList.remove("hidden");
    const r = t.getBoundingClientRect();
    tipEl.style.left = Math.max(6, Math.min(r.left, innerWidth - tipEl.offsetWidth - 6)) + "px";
    tipEl.style.top = (r.bottom + 6 + tipEl.offsetHeight > innerHeight ? r.top - tipEl.offsetHeight - 6 : r.bottom + 6) + "px";
  }, 250);
});
document.addEventListener("mousedown", () => tipEl.classList.add("hidden"));
