// "Oops!": report a bug or ask for a feature. Fills in a new GitHub issue (repo from git's origin) and opens it in the browser,
// so nothing is sent until you press Submit on GitHub, and no token is needed.
"use strict";
const feedback = (() => {
  const QUIPS = {
    bug: ["The gremlins are loose again", "Something went sideways", "It worked on my machine (ha)", "Claude has opinions about this one"],
    feature: ["I demand a new shiny thing", "Wouldn't it be nice if…", "Make it do a backflip", "One small feature (famous last words)"],
  };
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const TEMPLATES = {
    bug: "**What happened?**\n\n\n**What did you expect?**\n\n\n**How to make it happen again**\n1. \n2. \n",
    feature: "**What would you like Yo Claude to do?**\n\n\n**Why would that help?**\n\n",
  };

  async function open(kind = "bug") {
    const info = await api().issue_info().catch(() => ({}));
    const d = dialog("🪲 Oops! Tell us what's up");
    d.classList.add("wide", "feedback");
    d.appendChild(el("p", "dim", "Found a bug? Want a feature? This opens a ready-filled GitHub issue. Nothing is sent until you press Submit over there. 🕵️"));
    const row = el("div", "fbkinds");
    const kinds = { bug: "🪲 Something's broken", feature: "💡 I want a thing" };
    const btns = {};
    const title = el("input"), body = el("textarea"); body.rows = 9;
    body.style.width = "100%";
    const set = (k) => {
      kind = k;
      for (const [n, b] of Object.entries(btns)) b.classList.toggle("on", n === k);
      title.placeholder = pick(QUIPS[k]);
      if (!body.dataset.touched) body.value = TEMPLATES[k].replace(/\n/g, "\n");
    };
    for (const [k, label] of Object.entries(kinds)) { btns[k] = el("button", "fbk", label); btns[k].onclick = () => set(k); row.appendChild(btns[k]); }
    body.oninput = () => { body.dataset.touched = "1"; };
    d.append(row, title, body);
    const mk = (text, on) => { const l = el("label", "pick"); const c = el("input"); c.type = "checkbox"; c.checked = on; l.append(c, " " + text); d.appendChild(l); return c; };
    const withEnv = mk(`Include my version and PC details (${info.version || "?"}, ${info.os || "Windows"})`, true);
    const withLog = mk("Include the latest errors from Yo Claude's log (they'll be in the issue text, so check them there first)", false);
    set(kind);
    const go = () => {
      const t = title.value.trim() || title.placeholder;
      let extra = "";
      if (withEnv.checked) extra += `\n\n---\nYo Claude ${info.version || "?"} · ${info.os || ""}`;
      let lines = withLog.checked ? (info.log || []).slice() : [];
      const build = () => `${body.value.trim()}${extra}${lines.length ? "\n\n<details><summary>Recent log</summary>\n\n```\n" + lines.join("\n") + "\n```\n</details>" : ""}`;
      const url = () => `${info.repo}/issues/new?labels=${kind === "bug" ? "bug" : "enhancement"}&title=${encodeURIComponent((kind === "bug" ? "🪲" : "💡") + t)}&body=${encodeURIComponent(build())}`;
      while (lines.length && url().length > 7000) lines.shift();   // (a browser address has a limit)
      closeModal();
      api().open_url(url());
      toast(kind === "bug" ? "Off to GitHub it goes. The bug squad (one human, much coffee) has been summoned ☕" : "Your wish is on its way to GitHub. No promises about unicorns 🦄");
    };
    addButtons(d, [["never mind", closeModal], ["open on GitHub ↗", go, "primary"]]);
    setTimeout(() => title.focus(), 0);
  }

  const mkBtn = (id, label, title, kind) => {
    const b = el("button", "", label);
    b.id = id; b.title = title; b.onclick = () => open(kind);
    $("#helpBtn").before(b);
  };
  mkBtn("bugBtn", "[🪲Report Bug]", "Something broken? Tell us, GitHub style", "bug");
  mkBtn("featBtn", "[💡Request Feature]", "Want Yo Claude to do something new? Tell us, GitHub style", "feature");
  return { open };
})();
