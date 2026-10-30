// Retro video player: our own controls and ⋮ menu instead of Chromium's, with a picture-in-picture button on top.
"use strict";
const PIP_ICON = `<svg viewBox="0 0 14 12" width="14" height="12" shape-rendering="crispEdges"><path fill="none" stroke="currentColor"
  stroke-width="1.5" d="M1 1h12v10H1z"/><path fill="currentColor" d="M7 6h5v4H7z"/></svg>`;
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const clock = (s) => !isFinite(s) ? "0:00" : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

function retroPlayer(m, { autoplay = false, big = false, cwd } = {}) {
  const box = el("div", "rplayer" + (big ? " big" : ""));
  const v = el("video");
  v.src = m.url; v.preload = "metadata"; v.autoplay = autoplay; v.playsInline = true;
  box.innerHTML = `<button class="rp-pip" data-tip="Picture in picture: keeps playing on top of other windows">${PIP_ICON}</button>
    <button class="rp-big">▶</button>
    <div class="rp-bar"><button class="rp-play" data-tip="Play / pause (space)">▶</button><div class="rp-seek"><span></span></div>
      <span class="rp-time">0:00 / 0:00</span><button class="rp-mute" data-tip="Mute">♪</button><button class="rp-more" data-tip="More">⋮</button></div>`;
  box.prepend(v);
  const q = (s) => box.querySelector(s), seek = q(".rp-seek");
  const sync = () => {
    q(".rp-play").textContent = v.paused ? "▶" : "❚❚";
    box.classList.toggle("playing", !v.paused);
    q(".rp-mute").textContent = v.muted ? "×" : "♪";
    q(".rp-seek span").style.width = (v.duration ? 100 * v.currentTime / v.duration : 0) + "%";
    q(".rp-time").textContent = `${clock(v.currentTime)} / ${clock(v.duration)}`;
  };
  v.addEventListener("error", () => {   // file deleted or moved since, or a format WebView2 can't play
    const gone = v.error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED || v.error?.code === MediaError.MEDIA_ERR_NETWORK;
    box.querySelectorAll(".rp-big, .rp-pip").forEach((n) => n.remove()); box.style.minHeight = "120px";
    box.appendChild(el("div", "rp-error", gone ? "✗ can't play this: the file may have been moved or deleted, or it's a format this window can't play.<br>right-click: show in explorer, open with…"
                                              : "✗ this video couldn't be played"));
  });
  ["play", "pause", "timeupdate", "loadedmetadata", "volumechange", "ended"].forEach((ev) => v.addEventListener(ev, sync));
  const toggle = () => {
    if (v.paused) { document.querySelectorAll(".rplayer video").forEach((o) => o !== v && o.pause()); v.play(); } else v.pause();
  };
  const pip = async () => {
    try { document.pictureInPictureElement === v ? await document.exitPictureInPicture() : (await v.requestPictureInPicture(), v.play()); }
    catch (_) { toast("Picture in picture isn't available here"); }
  };
  const full = () => document.fullscreenElement ? document.exitFullscreen() : box.requestFullscreen();
  const menu = (at) => showMenu(at, [   // every row gets a tick column so the labels line up
    [document.fullscreenElement ? "exit full screen" : "full screen", full, { kbd: "dbl-click" }],
    ["picture in picture", pip, { checked: document.pictureInPictureElement === v }],
    ["mute", () => { v.muted = !v.muted; }, { checked: v.muted }],
    ["loop", () => { v.loop = !v.loop; }, { checked: v.loop }],
    "-", ["sub:playback speed"],
    ...SPEEDS.map((s) => [`${s}×`, () => { v.playbackRate = s; }, { checked: v.playbackRate === s }]),
    ...(m.path ? ["-", ["pop out in its own window", () => { v.pause(); closeModal(); api().pop_out(m.path, cwd); }],
                  ["show in explorer", () => api().open_path(m.path, "reveal", cwd)],
                  ["copy path", () => copyText(m.path, "path copied")]] : []),
  ].map((it) => Array.isArray(it) && it[1] ? [it[0], it[1], { checked: false, ...it[2] }] : it));
  const stop = (fn) => (e) => { e.stopPropagation(); fn(e); };
  v.onclick = stop(toggle);
  q(".rp-big").onclick = stop(toggle);
  q(".rp-play").onclick = stop(toggle);
  v.ondblclick = stop(full);
  q(".rp-pip").onclick = stop(pip);
  q(".rp-mute").onclick = stop(() => { v.muted = !v.muted; });
  q(".rp-more").onclick = stop((e) => menu(e.currentTarget));
  box.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); menu({ clientX: e.clientX, clientY: e.clientY }); };
  box.onclick = (e) => e.stopPropagation();
  const seekTo = (e) => { const r = seek.getBoundingClientRect(); if (v.duration) v.currentTime = v.duration * Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  seek.onpointerdown = (e) => { e.stopPropagation(); seek.setPointerCapture(e.pointerId); seekTo(e); seek.onpointermove = seekTo; };
  seek.onpointerup = () => { seek.onpointermove = null; };
  box.tabIndex = 0;
  box.onkeydown = (e) => {
    if (e.key === " " || e.key === "k") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowRight") v.currentTime += 5; else if (e.key === "ArrowLeft") v.currentTime -= 5;
    else if (e.key === "f") full(); else if (e.key === "m") v.muted = !v.muted;
  };
  if (!document.pictureInPictureEnabled) q(".rp-pip").remove();
  sync();
  return box;
}
// In full screen only the player shows, so the menu and tooltips move into it and back.
document.addEventListener("fullscreenchange", () => {
  const host = document.fullscreenElement || document.body;
  for (const n of [$("#menu"), document.querySelector(".tip")]) if (n && n.parentNode !== host) host.appendChild(n);
});
