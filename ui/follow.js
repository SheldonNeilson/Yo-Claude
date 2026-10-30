// "Follow" toggles for the chat and the task/subagent output. While on, new output keeps the view at the bottom.
// Scrolling up yourself (wheel, scrollbar drag, keys, touch) switches it off so the view stays where you put it;
// clicking it switches it back on and jumps to the newest output. Views are re-rendered often, so buttons and
// scroll containers are registered again on each render; the on/off state lives here.
const follow = {
  on: { chat: true, task: true },
  btns: { chat: new Set(), task: new Set() },
  els: { chat: null, task: new Set() },
  bound: new WeakSet(),
  pos: {},               // last scroll position per container id; containers get rebuilt, so restore from here

  button(name) {
    const b = document.createElement("button");
    b.className = "followbtn";
    b.onclick = () => {
      this.set(name, !this.on[name]);
      if (this.on[name]) this.stickAll(name);
    };
    this.btns[name].add(b);
    this.paint(name);
    return b;
  },
  paint(name) {
    for (const b of [...this.btns[name]]) {
      if (!b.isConnected && b.dataset.placed) { this.btns[name].delete(b); continue; }
      b.dataset.placed = "1";
      b.classList.toggle("on", this.on[name]);
      b.textContent = this.on[name] ? "⤓ follow" : "⤓ follow (off)";
      b.dataset.tip = this.on[name] ? "Following new output. Scroll up to stop."
                                    : "Not following. Click to jump to the newest output and follow again.";
    }
  },
  set(name, on) {
    if (this.on[name] === on) return;
    this.on[name] = on;
    this.paint(name);
  },

  // Watch a scroll container for the user scrolling up. Safe to call on every render.
  bind(name, el) {
    if (!el) return;
    if (name === "chat") this.els.chat = el; else this.els.task.add(el);
    if (this.bound.has(el)) return;
    this.bound.add(el);
    const scrollable = () => el.scrollHeight > el.clientHeight + 2;
    const off = () => { if (scrollable()) this.set(name, false); };
    el.addEventListener("wheel", (e) => { if (e.deltaY < 0) off(); }, { passive: true });
    el.addEventListener("keydown", (e) => { if (["ArrowUp", "PageUp", "Home"].includes(e.key)) off(); });
    let dragging = false, touchY = null;
    el.addEventListener("pointerdown", (e) => {   // a press on the scrollbar (right edge) is a drag of the bar
      dragging = e.offsetX >= el.clientWidth;
    });
    window.addEventListener("pointerup", () => { dragging = false; });
    let lastTop = el.scrollTop;
    el.addEventListener("scroll", () => {
      if (dragging && el.scrollTop < lastTop) off();
      lastTop = el.scrollTop;
      if (el.id) this.pos[el.id] = el.scrollTop;
    }, { passive: true });
    el.addEventListener("touchstart", (e) => { touchY = e.touches[0]?.clientY ?? null; }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      const y = e.touches[0]?.clientY;
      if (touchY !== null && y > touchY + 8) off();   // finger moving down = content scrolling up
    }, { passive: true });
  },

  // Keep a container at the bottom if following.
  stick(name, el) {
    if (this.on[name] && el) el.scrollTop = el.scrollHeight;
  },
  stickAll(name) {
    if (name === "chat") return this.stick(name, this.els.chat);
    for (const el of [...this.els.task]) {
      if (!el.isConnected) { this.els.task.delete(el); continue; }
      this.stick(name, el);
    }
  },
};
