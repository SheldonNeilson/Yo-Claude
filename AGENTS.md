# Yo Claude — agent notes

Voice-first Claude assistant for Windows (see README.md). Shared with friends from
https://github.com/SheldonNeilson/Yo-Claude (private); their installs update from `main`.

## Rules

- **Bump `VERSION` on every push to GitHub** (semver: patch for fixes, minor for features). Installs compare it with
  GitHub's to show "update available". `hooks/pre-push` refuses a push to `main` with an unchanged `VERSION`; enable
  it in a clone with `git config core.hooksPath hooks`.
- **Before restarting Yo Claude**, read `~/.yoclaude/status.json`: it lists sessions mid-reply and background tasks.
  Restarting cuts off replies in progress (background tasks survive and are picked up again).
- **To restart Yo Claude**, create the empty file `~/.yoclaude/restart-request` (or File → Restart). It waits until
  no session is mid-reply, quits the normal way and starts again; don't kill its process (that ends background tasks
  with it). Tasks a restart cut off are reported to their session, which starts them again.
- Screenshots in `docs/screenshots/` use made-up demo content only: never real sessions, folders or chats.
- Test scripts that drive the Agent SDK create real sessions, which then show up in the user's session list. Move the
  ones a test made into `~/.yoclaude/trash/<project folder>/` when it's done.

## Layout

| File | What |
|---|---|
| `app.py` | entry point: windows (pywebview), tray, event bus, updates, quit |
| `sessions.py` | Claude sessions on the Agent SDK: router, transcript items, approvals, background tasks |
| `yo_claude.py` | voice engine: wake word (Vosk), speech detection (Silero), Whisper, voice (edge-tts) |
| `workspace.py` | files, git, per-session change snapshots |
| `media.py`, `taskbar.py`, `icons.py` | local file links, taskbar state, mascot icons |
| `ui/` | the window and the floating bar (plain HTML/JS, no build step) |
| `pc_control/` | bundled screen-control MCP server (own environment) |
| `install.ps1` / `uninstall.ps1` | install, update (`-Update`), remove |
