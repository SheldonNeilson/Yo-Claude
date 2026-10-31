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
| `terminal.py` | shells on a pseudo-console (pywinpty) for the terminal pane (`ui/terminal.js`, xterm.js in `ui/vendor/`) |
| `media.py`, `taskbar.py`, `icons.py` | local file links, taskbar state, mascot icons |
| `ui/` | the window and the floating bar (plain HTML/JS, no build step) |
| `pc_control/` | bundled screen-control MCP server (own environment) |
| `install.ps1` / `uninstall.ps1` | install, update (`-Update`), remove |

## Avatar training plan (the six faces): status, next steps, open questions

**Keep this section up to date after every training run** (counts, what was changed, what you learned), so the next session can
carry on without re-reading the history. Last updated: 2026-10-31 evening.

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

### Status at last update
- Running now: all six jobs (12 python processes), started about 18:00 on 2026-10-31 with the fixed uploader.
- Clips on disk (raw = in the app): Female 1 71, Male 1 9, Male 2 3, Female 2 3, Female 3 3, Male 3 3.
- Remaining to record on the active lists: about 190 clips (Female 1 ~34, Male 1 ~43, the other four ~30 each), about 12 hours at the
  current rate. Check the real numbers from the folders, not from this note.
- % target rule used for the lists (REVIEW-new-lists.md): per category (resting / thinking / talking / other) aim for the average % of
  the characters not at 100%, never above the highest % below 100; nobody is taken to 100%. Talking has 1 to 2 entries per
  character (all done), so it has no target.

### Next steps
1. Let the jobs finish (progress: count the `*.mp4` in each `clips\` folder against `wishlist.json`; per-state tables are quick to
   recompute: `idle*` / `think*` / `talk*` / other).
2. When a character's job ends, run `audit_ids.py` and look at a contact sheet of its clips; quarantine anything that isn't them.
3. Add a few more `talking_*` variants for every character (the thinnest state), and check the lip sync works with them.
4. Make Male 1's resting clips match the others (his list asks for 101, about 14 exist at best; the trimmed list asks for 48).
5. After each run: update the status block above, and commit any `ui/avatar/**` clips and `clips.json` (a push needs a `VERSION` bump).
6. Female 1's mannerisms: `ui/avatar.js` slows clips that move much faster than the typical one (`paceAll`, `PACE_ABOVE`); ask the
   user which, if any, still look wrong rather than guessing again.

### Open questions
- Is the crude identity classifier good enough, or should a real face-embedding check go into `make_avatar_clips.py` (it only compares
  with `idle.mp4` today)?
- Female 1 has about 20 clips that aren't on her current list; keep them? Male 1 had many ComfyUI "didn't start" failures earlier:
  were any of his clips lost to that rather than to the identity swap?
- Should the six jobs run one after another instead of together? Same total speed (the GPU is the limit), but a safer pipeline.
- Voices: Male 3 and Female 3 were moved from Singapore English to American (`yo_claude.py` `VOICES`); not yet listened to.
