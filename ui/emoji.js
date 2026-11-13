// Emoji picker for the message box: [emoji] under it opens a grid; a click puts the emoji at the cursor (Shift-click keeps the
// picker open for several). Windows' own picker (Win + .) works in the box too.
"use strict";
(() => {
  const SETS = [
    ["faces", "😀 😃 😄 😁 😆 😅 😂 🤣 🙂 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 🤔 🤨 😐 😑 😶 🙄 😏 😬 😌 😴 😎 🤓 🥳 😕 😟 😢 😭 😤 😡 🤯 😱 😳 🥺 🤗 🫡 🤝".split(" ")],
    ["hands", "👍 👎 👌 ✌️ 🤞 🤘 👋 🙏 👏 🙌 💪 👀 🫶 ☝️ 👉 👈 ✋ 🖖".split(" ")],
    ["hearts", "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 💔 ✨ 🔥 ⭐ 🌟 💯 🎉 🎊 🏆".split(" ")],
    ["work", "💻 🖥️ ⌨️ 🖱️ 📁 📂 📄 📝 📋 📌 📎 🔧 🔨 🛠️ ⚙️ 🔍 🔒 🔑 🪲 🚀 📦 🧪 📊 📈 📉 💡 ⏰ 📅 ✉️ 📞".split(" ")],
    ["signs", "✅ ❌ ⚠️ ❗ ❓ ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔄 ♻️ 🚫 💬 🔔 🔇 ⏳ 🟢 🟡 🔴 🔵".split(" ")],
    ["fun", "🐱 🐶 🦊 🐻 🐼 🦁 🐸 🐢 🦄 🌈 ☀️ 🌙 ☕ 🍕 🍔 🍺 🍰 🎮 🎵 🎸 ⚽ 🏍️ 🛵 🚗 ✈️".split(" ")],
  ];
  const input = $("#input"), btn = el("button", "", "[emoji]");
  btn.id = "emojiBtn"; btn.title = "Add an emoji to your message";
  btn.addEventListener("mousedown", (e) => e.preventDefault());   // (the message box keeps its cursor)
  $("#termBtn").after(btn);
  const pick = el("div", "menu hidden"); pick.id = "emojiPick";
  for (const [name, list] of SETS) {
    pick.appendChild(el("div", "epname", name));
    const row = el("div", "epgrid");
    for (const e of list) row.appendChild(el("button", "ep", e));
    pick.appendChild(row);
  }
  $("#composer").appendChild(pick);
  const close = () => pick.classList.add("hidden");
  pick.addEventListener("mousedown", (e) => e.preventDefault());
  pick.addEventListener("click", (e) => {
    const b = e.target.closest(".ep");
    if (!b) return;
    input.focus();
    input.setRangeText(b.textContent, input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    if (!e.shiftKey) close();
  });
  btn.onclick = () => pick.classList.toggle("hidden");
  document.addEventListener("mousedown", (e) => { if (!pick.contains(e.target) && e.target !== btn) close(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pick.classList.contains("hidden")) { close(); input.focus(); } }, true);
  // Typed shortcuts become emojis: ":)" and friends when you finish them with a space or Enter, ":name:" as soon as the closing
  // colon is typed. Only a whole word (after a space or the start), so URLs and code like "http:/" are left alone.
  const FACES = { ":)": "🙂", ":-)": "🙂", "(:": "🙂", ":D": "😄", ":-D": "😄", ";)": "😉", ";-)": "😉", ":(": "🙁", ":-(": "🙁", ":'(": "😢",
    ":P": "😛", ":p": "😛", ":-P": "😛", ":O": "😮", ":o": "😮", "B)": "😎", "8)": "😎", "<3": "❤️", "</3": "💔", "xD": "😆", "XD": "😆", "^^": "😊" };
  const NAMES = { smile: "😄", grin: "😁", joy: "😂", laugh: "🤣", wink: "😉", heart: "❤️", thumbsup: "👍", "+1": "👍", thumbsdown: "👎", "-1": "👎",
    fire: "🔥", rocket: "🚀", tada: "🎉", party: "🥳", check: "✅", white_check_mark: "✅", x: "❌", warning: "⚠️", thinking: "🤔", eyes: "👀",
    pray: "🙏", clap: "👏", wave: "👋", bug: "🪲", star: "⭐", sparkles: "✨", "100": "💯", coffee: "☕", cat: "🐱", dog: "🐶", cry: "😢",
    sob: "😭", sunglasses: "😎", muscle: "💪", ok: "👌", bulb: "💡", lock: "🔒", key: "🔑", gear: "⚙️", zap: "⚡", skull: "💀", poop: "💩" };
  let busy = false;
  const swap = (from, to, text) => {   // replace text[from..to) with `text`, cursor after it
    busy = true;
    input.setRangeText(text, from, to, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    busy = false;
  };
  function convert(endOfWord) {   // endOfWord: the word ends at the cursor (a space or Enter is next); else only ":name:" is looked for
    const caret = input.selectionStart, before = input.value.slice(0, caret);
    const m = /(?:^|\s)(\S+)$/.exec(before);
    if (!m) return false;
    const w = m[1], at = caret - w.length;
    if (endOfWord && FACES[w]) { swap(at, caret, FACES[w]); return true; }
    const n = /^:([a-z0-9_+-]+):$/i.exec(w);
    if (n && NAMES[n[1].toLowerCase()]) { swap(at, caret, NAMES[n[1].toLowerCase()]); return true; }
    return false;
  }
  input.addEventListener("input", (e) => {
    if (busy || e.isComposing || e.inputType !== "insertText" || input.selectionStart !== input.selectionEnd) return;
    if (e.data === ":") convert(false);
    else if (e.data === " ") {   // the space just typed ends the word before it: convert that word, keep the space
      const caret = input.selectionStart;
      input.setSelectionRange(caret - 1, caret - 1);
      const done = convert(true);
      if (!done) input.setSelectionRange(caret, caret);
      else input.setSelectionRange(input.selectionStart + 1, input.selectionStart + 1);
    }
  });
  input.addEventListener("keydown", (e) => {   // Enter sends: convert a shortcut at the very end first
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing && input.selectionStart === input.selectionEnd) convert(true);
  }, true);
})();
