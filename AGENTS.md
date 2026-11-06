# Yo Claude — agent notes

Voice-first Claude assistant for Windows (see README.md). Shared with friends from
https://github.com/SheldonNeilson/Yo-Claude (public, MIT code; the avatar clips are covered by `NOTICE.md`, not MIT); installs update from `main`.

## Rules

- **Auto-update:** installs update themselves (setting `auto_update`, default on; Tools menu and tray toggle): `check_updates` in `app.py` shows a 30 s countdown with cancel (`update_countdown`; cancelled = asked again in 6 h), then installs when no reply is in progress, only if the clone is clean and not ahead of GitHub. `install_update` leaves `~/.yoclaude/updated.json`; the next start shows "was updated" with the commits since (`updated_note`).
- **Bump `VERSION` on every push to GitHub** (semver: patch for fixes, minor for features). Installs compare it with
  GitHub's to show "update available". `hooks/pre-push` refuses a push to `main` with an unchanged `VERSION`; enable
  it in a clone with `git config core.hooksPath hooks`.
- **Before restarting Yo Claude**, read `~/.yoclaude/status.json`: it lists sessions mid-reply and background tasks.
  Restarting cuts off replies in progress. Background shell commands survive and are picked up again; background
  subagents stop (the old Claude process is ended when the conversation reconnects, so there is only ever one Claude
  per conversation: `end_leftover_claudes`), and the restart notice tells Claude to start them again.
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
| `ui/selfctl.js` | Claude's own hands on the window: the `ui_state` / `ui_control` tools (`Session.ui_tools`, `Router.ui_call`) run here and answer through `api().ui_report` |
| `terminal.py` | shells on a pseudo-console (pywinpty) for the terminal pane (`ui/terminal.js`, xterm.js in `ui/vendor/`) |
| `media.py`, `taskbar.py`, `icons.py` | local file links, taskbar state, mascot icons |
| `ui/` | the window and the floating bar (plain HTML/JS, no build step) |
| `pc_control/` | bundled screen-control MCP server (own environment) |
| `plugins.py`, `ui/plugins.js` | toolbar plugins (below) |
| `install.ps1` / `uninstall.ps1` | install, update (`-Update`), remove |

## Plugins (toolbar buttons)

Not the Claude Code plugins/mods (those are Claude's own, switched in Options > MCP). These are Yo Claude's: folders in
`~/.yoclaude/plugins/<name>/plugin.json`, **outside the repo and the installer**, so a private plugin is never shipped or pushed.
Read at startup and by Tools > Reload plugins (Tools > Open plugins folder). Spec and manifest format: docstring of `plugins.py`.
- Manifest: name, description, version, `buttons[]` (id, icon, label, tooltip, `run`, optional `placement` and `order`). Each button
  shows as `[icon label]`. `placement` (on the plugin as the default, or on a button): `header` (default; the top row with the
  mic/voice toggles, `top` is an alias), `menubar` (the very top, by the pane buttons) or `composer` (under the message box);
  `order` sorts within a place. `run.kind` `compose` (`text`) puts the text in the message box and focuses it, sending nothing; a
  `review` action may set `when_empty` (text) so that an empty preview also fills the message box (a way to give it something to add).
  `run.kind` is `command` (run it, show output as a note) or `review` (run `preview`, which prints a JSON array;
  show it as Claude's tick-list card with a per-row why/note; on [submit] run `apply` with only the ticked rows in a temp JSON
  file, `{file}`). Review cards reuse `checklist` items; `Router.plugin_jobs` maps the card to the plugin, so [submit] goes to
  the plugin, not to Claude.
- **Keep a plugin self-contained**: its scripts and config live in its own folder and the manifest refers to them as `{plugin_dir}` (also each command's working directory), so copying the folder shares it; per-user data goes under `%LOCALAPPDATA%`, never inside.
- Failures are isolated: a bad manifest is skipped and reported in a toast; a failing command shows an error in the session.
- Plugins run commands as the user (no sandbox): they are trusted local scripts. Keep any plugin with private data or
  private paths in `~/.yoclaude/plugins`, never in the repo. `YOCLAUDE_PLUGINS_DIR` overrides the folder (for tests).

## Avatar faces

Six characters (Options > Face), each a set of short image-to-video clips in `ui/avatar/` (Female 1 at the top level, the others in
`ui/avatar/<name>/`, each folder with a `clips.json` manifest), ASCII-rendered live by `ui/avatar.js`. Clip names set the state: `idle*`
resting, `think*` thinking, `talk*` talking, `listen*`/`laugh*`/`look*` other. `idle.mp4` is every clip's shared start frame.
`scripts/make_avatar_clips.py` builds a character's clips and drops any whose first frame isn't the same person as `idle.mp4`.
Sources and licensing: `NOTICE.md` (the clips are not MIT).

- Clips that must not play at random are listed in `HIDDEN` in `ui/avatar.js` (they stay on disk): a finger on the lips reads as a
  shush, an open mouth looks odd on repeat. Look at every new hand-near-face or wide-mouth clip (contact sheet of 8 frames) before it
  joins the pool.
- `ui/avatar.js` slows clips that move much faster than the rest (`paceAll`), in every state.
- After adding clips, commit them and `clips.json`; a push needs a `VERSION` bump.
- The maker's working notes (recording jobs, status, open questions) are kept locally in `AVATAR-TRAINING.local.md`, which is gitignored
  because it names private folders on the author's PC.
