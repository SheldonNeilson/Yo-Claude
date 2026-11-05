# Yo Claude — agent notes

Voice-first Claude assistant for Windows (see README.md). Shared with friends from
https://github.com/SheldonNeilson/Yo-Claude (private); their installs update from `main`.

## Rules

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
- Manifest: name, description, version, `buttons[]` (id, icon, label, tooltip, `run`). Each button shows as `[icon label]` on the
  composer row. `run.kind` is `command` (run it, show output as a note) or `review` (run `preview`, which prints a JSON array;
  show it as Claude's tick-list card with a per-row why/note; on [submit] run `apply` with only the ticked rows in a temp JSON
  file, `{file}`). Review cards reuse `checklist` items; `Router.plugin_jobs` maps the card to the plugin, so [submit] goes to
  the plugin, not to Claude.
- Failures are isolated: a bad manifest is skipped and reported in a toast; a failing command shows an error in the session.
- Plugins run commands as the user (no sandbox): they are trusted local scripts. Keep any plugin with private data or
  private paths in `~/.yoclaude/plugins`, never in the repo. `YOCLAUDE_PLUGINS_DIR` overrides the folder (for tests).

## Avatar training plan (the six faces): status, next steps, open questions

**Keep this section up to date after every training run** (counts, what was changed, what you learned), so the next session can
carry on without re-reading the history. Last updated: 2026-11-02 morning.

### What it is
Each character is a real-looking face: short clips (5 s, 12 fps, ASCII-rendered live by `ui/avatar.js`) made with ComfyUI image-to-video
from one cleaned photo. Characters (Options > Face > Character): Female 1 = `female` (clips in `ui/avatar/` itself), Male 1 = `male`,
Male 2 = `professor`, Female 2 = `female2`, Female 3 = `female3`, Male 3 = `male3` (each in `ui/avatar/<name>/`, with a `clips.json`
manifest). Clip names set the state: `idle*` resting, `think*` thinking, `talk*` talking, `listen*`/`laugh*`/`look*` other.
`idle.mp4` is every clip's shared start frame; `make_avatar_clips.py` drops a clip whose first frame isn't the same person as `idle.mp4`.

### Where things are (outside the repo, on this PC)
- Work folder `D:\Temp\yoclaude-faces\` (per character: `professor\`, `female2\`, `female3\`, `male\`, `male3\`; Female 1 is the root
  plus `clips-neutral\`). Each has `wishlist.json` (the ACTIVE list the job reads; it re-reads it after every clip and exits when
  nothing is left to make), `wishlist.full.json` (the untouched original), `wishlist.proposed.json`, a `.log`, `start-framed.png`
  (the photo, framed like Female 1), `start-neutral.png` + `first-idle.mp4` (the calm start frame, made by the job), `clips\` (raw).
- Jobs: `gen_char.py <char> <K> <he|she>` (Male 2/Female 2/Female 3/Male 3), `gen_male.py` (Male 1), `gen_more.py` (Female 1);
  started by each character's `run.ps1` / `male\run-male2.ps1` / `run-more2.ps1` (python from `D:\Workspaces\Oddly Based\.venv`).
  They share one ComfyUI (port 8188) and one GPU: about 13 to 15 minutes per clip with six running, roughly 16 clips an hour in total.
- Checks: `identity-audit.json` + `D:\Temp\yoclaude-scratch\edits\audit_ids.py` (crude identity classifier: 24x32 thumbnails vs the six
  references; fine for telling these six apart, not a face-recognition model). `REVIEW-new-lists.md` explains the % target rule.
- `quarantine-wrong-faces\` folders (per character) hold clips that turned out to be the wrong person (kept, not deleted).

### What went wrong, and the fix (2026-10-31)
All six jobs ran at once and uploaded their start picture to ComfyUI under the same file name (`start-framed.png`) with overwrite on,
so jobs swapped each other's starting image: Male 2 came out as Female 1's face, Female 2 as Male 1, Female 3 and Male 3 as the same
man. Fixed in `Oddly Based\oddly\render\comfyui.py` (`upload()` now prefixes a hash of the file's full path). Everything recorded
concurrently before the fix was quarantined and the lists restarted; the four new first-idle clips were checked by eye afterwards and
are the right people. Female 1 (35) and Male 1 (28) lost the clips that came out as someone else.
**If you ever see a wrong face again, check uploads and `first-idle.mp4` first**: the same-person guard compares with `idle.mp4`, so a
wrong idle makes every following clip "match".

### Status at last update (2026-11-02 morning)
- Round two finished (`D:\Temp\yoclaude-scratch\round_robin.ps1`: one clip per character in turn, `YC_MAX_CLIPS=1` in `gen_char.py`/`gen_male.py`; the lists were
  topped up to 61 each). Clips in the app: Female 1 103; Male 1, Male 2, Female 2, Female 3, Male 3 61 each. `audit_ids.py`: all the right person.
  Contact sheets of the 140 new clips: no hands near faces, no shush. `idle_breathe_deep` (wide open mouth, odd neck) and `idle_curious`
  (pucker, wide eyes) are in `HIDDEN`. Watch `idle_v_content` / `idle_v_smile_half` (Male 1): broad teeth grins as a resting clip.
  Run recorders **one after another** (parallel swamped ComfyUI); about 4 minutes a clip alone, some time out after 1800 s and the
  driver retries them. Start jobs from a script file, never an inline command. Only Female 1 has `idle_sigh_soft`.
- Reviewed by contact sheet: `listen_lean_closed` and `idle_sigh_soft` are good (the sigh parts the lips a little: acceptable). `idle_yawn` (wide
  mouth, hand over it) and `idle_wave` are kept; `idle_thumbs_up` is hidden (meaningless as an idle gesture).
- % target rule used for the lists (REVIEW-new-lists.md): per category (resting / thinking / talking / other) aim for the average % of
  the characters not at 100%, never above the highest % below 100; nobody is taken to 100%.

### Next steps
1. (done 2026-11-01) second batch audited and reviewed.
2. `idle_sigh_soft` (and any other missing mannerism) for the four characters that lack it, if the user wants it.
3. Look at every new hand-near-face or wide-mouth clip before it joins the pool (see below).
4. After each run: update this status block and commit the clips and `clips.json` (a push needs a `VERSION` bump).

### Clips that must not play at random (`HIDDEN` in `ui/avatar.js`, all characters)
`think_tap_lips` = a straight finger on the lips, i.e. a shush: only for shushing, never idling or thinking. `listen_lean` (leans in
with the mouth wide open) and `idle_s_swallow` (mouth open) look odd on repeat. They stay on disk. **Look at every new hand-near-face
or wide-mouth clip before it joins the pool** (contact sheet of 8 frames per clip); a prompt like "taps her lips with one finger" gets
drawn as a shush, so word hand prompts as a curled finger on the chin or cheek. `idle_sigh` also opens the mouth wide: hidden too. The user wants a listening lean with the mouth CLOSED and a sigh that is head-back
and subtle: re-recording as `listen_lean_closed` (Female 1, Male 1) and `idle_sigh_soft` (Female 1) at the top of their wishlists
(2026-11-01). When they land, check them by contact sheet, then add the other characters' versions.

### Open questions
- Is the crude identity classifier good enough, or should a real face-embedding check go into `make_avatar_clips.py` (it only compares
  with `idle.mp4` today)?
- Female 1 has about 20 clips that aren't on her current list; keep them? Male 1 had many ComfyUI "didn't start" failures earlier:
  were any of his clips lost to that rather than to the identity swap?
- Should the six jobs run one after another instead of together? Same total speed (the GPU is the limit), but a safer pipeline.
- Voices: Male 3 and Female 3 were moved from Singapore English to American (`yo_claude.py` `VOICES`); not yet listened to.
