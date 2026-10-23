// Training mode: a guided intro for new people, then a calibration of the wake word for their voice and room.
// The engine reports every judgement it makes ("train" events) and never replies while this is open.
"use strict";
window.training = {
  step: 0, phase: null, wake: [], normal: [],

  open() { this.step = 0; this.wake = []; this.normal = []; this.phase = null; this.render(); },
  close() { if (this.phase) api().train(false); this.phase = null; closeModal(); },
  go(step) {
    this.step = step;
    const phase = step === 1 ? "wake" : step === 2 ? "normal" : null;
    if (phase && !this.phase) api().train(true);
    if (!phase && this.phase) api().train(false);
    this.phase = phase;
    this.render();
  },
  onJudgement(e) {
    if (this.phase === "wake") this.wake.push(e);
    else if (this.phase === "normal") this.normal.push(e);
    else return;
    this.render();
  },

  render() {
    const d = dialog(["Welcome to Yo Claude", "Step 1 of 2 · your wake word", "Step 2 of 2 · ordinary speech", "Results"][this.step]);
    d.classList.add("wide", "training");
    $("#modal").onclick = (e) => { if (e.target === $("#modal")) this.close(); };
    [this.intro, this.wakeStep, this.normalStep, this.results][this.step].call(this, d);
  },

  intro(d) {
    d.appendChild(el("div", "", `
      <p><b>Talk to Claude by saying “yo claude”.</b> It answers “how can I help?”; then just say what you want. Pause for a
      moment when you're done, and it sends it. Your audio stays on this PC: only the words it transcribes go to Claude.</p>
      <p><b>Follow-ups:</b> after it answers, it listens for about 6 seconds, so you can carry on without the wake word. Say
      <i>“never mind”</i> to stop. It keeps talking to the session open in this window.</p>
      <p><b>Voice commands:</b> <i>“new session”</i> (in the current folder), <i>“new chat”</i> (no folder),
      <i>“switch to &lt;session name&gt;”</i>.</p>
      <p><b>Coding:</b> pick a folder at the top left. Claude can read and edit files there; the right-hand panel shows the
      files, everything that changed in the session, and your git branch. When Claude asks permission it says what it wants
      to do: answer <i>“yes, go ahead”</i> or <i>“no”</i>, or click.</p>
      <p><b>Stop</b> anything with [■], a right-click on the bar, or the tray menu.</p>
      <p class="dim">Next: a two-minute check of how well it hears you, so it can tune itself to your voice and room.</p>`));
    addButtons(d, [["close", () => this.close()], ["start the check →", () => this.go(1), "primary"]]);
  },

  list(rows, expectWake) {
    const box = el("div", "trainlist");
    if (!rows.length) box.appendChild(el("div", "dim", "waiting for you…"));
    for (const r of rows) {
      const good = expectWake ? r.woke : !r.woke;
      box.appendChild(el("div", good ? "ok" : "bad", `${good ? "✓" : "✗"} heard “${esc(r.heard)}”${r.woke ? " · woke" : ""}`));
    }
    return box;
  },

  wakeStep(d) {
    const hits = this.wake.filter((r) => r.woke).length;
    d.appendChild(el("div", "", `<p>Say <b>“yo claude”</b> five times, in your normal voice, pausing for a second between
      each. It beeps when it hears it.</p><p class="big">${hits} of ${this.wake.length} heard</p>`));
    d.appendChild(this.list(this.wake, true));
    addButtons(d, [["cancel", () => this.close()],
      ["next →", () => this.go(2), this.wake.length >= 5 ? "primary" : ""]]);
  },

  normalStep(d) {
    const falses = this.normal.filter((r) => r.woke).length;
    d.appendChild(el("div", "", `<p>Now say three or four <b>ordinary sentences</b>, including some near-misses like
      <i>“you could close the cloud window”</i> or <i>“yo, call me later”</i>. These should <b>not</b> wake it.</p>
      <p class="big">${falses} false wake${falses === 1 ? "" : "s"}</p>`));
    d.appendChild(this.list(this.normal, false));
    addButtons(d, [["← back", () => this.go(1)], ["see results →", () => this.go(3), this.normal.length >= 3 ? "primary" : ""]]);
  },

  results(d) {
    const n = this.wake.length, hits = this.wake.filter((r) => r.woke).length;
    const falses = this.normal.filter((r) => r.woke).length;
    const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
    const peak = median(this.wake.map((r) => r.peak)), noise = median([...this.wake, ...this.normal].map((r) => r.noise));
    const snr = noise > 0 ? 20 * Math.log10(peak / noise) : 60;
    const tips = [];
    if (n && hits / n < 0.8) tips.push("It missed some. Try saying it a little more clearly, with a short pause after “claude”.");
    if (peak && peak < 600) tips.push("You're quiet for the mic: sit closer, or raise the microphone level in Windows sound settings.");
    if (snr < 15) tips.push("The room is noisy compared to your voice; fans, music or calls nearby make it miss more.");
    if (falses) tips.push("Something ordinary woke it. If that keeps happening, avoid extra accepted phrases below.");
    if (!tips.length) tips.push("Looks great: it hears you well and ignores ordinary speech.");

    // phrases it heard instead of the wake word, at least twice, never in ordinary speech: offer to accept them
    const normalTexts = new Set(this.normal.map((r) => r.heard));
    const counts = {};
    for (const r of this.wake) if (!r.woke && r.heard.split(" ").length >= 2 && r.heard !== "[unk]") counts[r.heard] = (counts[r.heard] || 0) + 1;
    const suggest = Object.entries(counts).filter(([t, c]) => c >= 2 && !normalTexts.has(t)).map(([t]) => t);
    const current = S.settings.wake_alternates || [];

    d.appendChild(el("div", "", `<p class="big">woke ${hits} of ${n} · ${falses} false wake${falses === 1 ? "" : "s"}</p>
      <p class="dim">your voice ${Math.round(peak)} · room ${Math.round(noise)} · ${Math.round(snr)} dB above the noise</p>
      <ul>${tips.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`));
    const picks = [];
    if (suggest.length || current.length) {
      d.appendChild(el("div", "", "<p><b>Also accept these as “yo claude” for you</b> (how it hears your voice):</p>"));
      for (const t of [...new Set([...current, ...suggest])]) {
        const row = el("label", "pick");
        const cb = el("input"); cb.type = "checkbox"; cb.checked = current.includes(t) || suggest.includes(t);
        row.append(cb, document.createTextNode(" " + t));
        picks.push([t, cb]); d.appendChild(row);
      }
    }
    addButtons(d, [["run again", () => this.open()],
      ["done", () => { if (picks.length) api().set_wake_alternates(picks.filter(([, cb]) => cb.checked).map(([t]) => t)); this.close(); }, "primary"]]);
  },
};
