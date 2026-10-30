"""Claude sessions for Yo Claude, on the Claude Agent SDK.

A session is either a **chat** (no folder: web tools only, cheap) or **code** (a folder: Claude Code's full toolset,
your user + project settings minus hooks). The router runs every session on one asyncio loop in its own thread,
keeps a live connection per open session so follow-ups skip the CLI start-up, turns SDK messages into transcript
items for the UI, and routes tool approvals to the UI and to voice.
"""

import asyncio
import base64
import datetime
import ctypes
import hashlib
import io
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
import warnings

import anyio
import claude_agent_sdk as sdk
from claude_agent_sdk._internal import sessions as sdk_sessions

import workspace

log = logging.getLogger("yo_claude")

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude")
PC_CONTROL_DATA = os.path.join(DATA_DIR, "pc-control")   # its log, saved macros and kill-switch file
CHAT_DIR = os.path.join(DATA_DIR, "home")       # cwd for chats: outside any project, so nothing project-level loads
TRASH_DIR = os.path.join(DATA_DIR, "trash")
VOICE_NOTE_MODEL = "claude-haiku-5-5"   # writes the short spoken lines (a separate call: nothing lands in the chat)
REOPEN_RECENT_S = 3 * 3600   # at start-up, the last conversation comes back if you used it this recently
TASKS_KEEP_S = 12 * 3600        # finished tasks stay in the tasks panel this long
TASKS_SHOWN = 40
TASK_TAIL_BYTES = 64 * 1024     # how much of a background command's output the panel shows
AGENT_QUIET_S = 120             # a subagent whose transcript hasn't changed for this long has probably stopped
META_PATH = os.path.join(DATA_DIR, "sessions.json")
PROJECTS_DIR = os.path.join(os.path.expanduser("~"), ".claude", "projects")
PC_CONTROL_SERVER = "screen-control"
WEB_TOOLS = ["WebSearch", "WebFetch"]
FILE_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write"]
READ_TOOLS = ["Read", "Glob", "Grep"]   # all a /btw side chat gets (plus the web tools): it can't change anything
CHAT_MODEL = "sonnet"
MAX_LIVE = 6              # connected sessions kept warm (several folders can be working at once)
HOLD_QUIET_S = 30         # a reply held open for a sent-now message lets go if Claude Code says nothing this long
ATTACH_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude", "attachments")   # pasted images, kept viewable
RESULT_PREVIEW = 4000     # characters of a tool result kept for the transcript
QUIET_DAYS = 7            # clean-up never suggests anything touched more recently
STALE_DAYS = 30           # ...and suggests anything untouched for this long
EMPTY_BYTES = 3_000       # session files this small have no real conversation in them
SMALL_BYTES = 20_000      # "short" conversations: suggested once they're QUIET_DAYS old

PERSONA = (
    "Yo Claude's voice is a warm, quick-witted young woman: friendly and a little playful. Now and then she teases "
    "gently or pokes fun at herself, but never at the user's expense, never cheesy or over the top, and never at the "
    "cost of being correct and clear. When the topic is serious or something went wrong, she's simply kind and direct."
)
VOICE_NOTE = (
    " Messages that start with [voice] were spoken and transcribed by speech recognition, so they may contain "
    "mistakes; interpret them sensibly. Your reply to a [voice] message is read aloud: start it with one or two plain "
    "conversational sentences (no markdown, lists, code or URLs) that give the answer or say what you did. Those "
    "spoken sentences are in this voice: " + PERSONA
)
# Her face's moods (from the reply she's reacting to) and the clip each plays; missing clips are skipped by the window.
MOODS = {"smile": "idle_tilt", "laugh": "laughing", "tease": "idle_brows", "shy": "idle_tuck", "proud": "think_nod",
         "curious": "looking", "playful": "hair", "thoughtful": "think_side", "calm": "idle_blink",
         "sorry": "idle_glance"}
CHAT_PROMPT = (
    "You are Claude inside Yo Claude, a voice and text assistant on the user's Windows PC. Keep spoken answers short, "
    "one to three sentences, unless the user asks for detail." + VOICE_NOTE
)
CODE_PROMPT = (
    "You are running inside Yo Claude, a voice-first coding assistant app on the user's Windows PC. For [voice] "
    "messages, put code, lists and detail after the spoken opening; the app shows them on screen." + VOICE_NOTE
)
UI_SERVER = "yo-claude"   # Claude's own tools for showing things in Yo Claude's window
UI_PROMPT = (
    " The user is looking at Yo Claude's window. When they ask to see, show or open something (a file, a folder, a "
    "diff), use the yo-claude tools: show_file opens a file in front of them, show_folder opens the files panel at a "
    "folder, show_diff shows what changed in a file, show_panel switches the right-hand panel. Reading a file yourself "
    "shows them nothing. Also use them when seeing it would help, but not for every file you touch. When they ask "
    "you to do something later or after a restart, queue it with queue_message."
)
CHECKLIST_PROMPT = (   # (with the checklist tool: Options > Tick Lists)
    " When the user should pick several things from a list (which to do, keep, include or fix), use the yo-claude "
    "checklist tool (mcp__yo-claude__checklist) instead of writing the list out: they tick yes or no for each item and "
    "can say why. For one choice between a few options, use AskUserQuestion instead."
)
PC_CONTROL_PROMPT = (
    " You can see and control the user's screen, keyboard and mouse with the screen-control tools; use them when the "
    "user asks you to do something on their PC, then say briefly what you did. Before anything hard to undo "
    "(deleting, sending, posting, buying, submitting), ask the user to confirm and wait for their reply."
)

# claude.exe is a console program: under pythonw each start would flash a console window.
_open_process = anyio.open_process


async def _open_process_no_window(*args, **kwargs):
    kwargs.setdefault("creationflags", subprocess.CREATE_NO_WINDOW)
    return await _open_process(*args, **kwargs)


anyio.open_process = _open_process_no_window


class _SubprocessNoWindow:
    """The SDK's session listing runs `git worktree list` per folder; without this each one flashes a console."""

    def __getattr__(self, name):
        return getattr(subprocess, name)

    @staticmethod
    def run(*args, **kwargs):
        kwargs.setdefault("creationflags", subprocess.CREATE_NO_WINDOW)
        return subprocess.run(*args, **kwargs)


sdk_sessions.subprocess = _SubprocessNoWindow()
# Chats pre-approve the web tools on purpose; the SDK warns that those then skip can_use_tool.
warnings.filterwarnings("ignore", category=sdk.CanUseToolShadowedWarning)


# --- metadata the SDK doesn't keep: groups, pins, where a session came from -----------------------------------
class Meta:
    def __init__(self):
        self.data = {"sessions": {}, "groups": [], "recent_folders": []}
        try:
            with open(META_PATH, encoding="utf-8") as f:
                self.data.update(json.load(f))
        except (OSError, ValueError):
            pass
        self.data.setdefault("workspaces", list(self.data["recent_folders"]))   # folders in the sidebar tree
        self.lock = threading.Lock()

    def save(self):
        with self.lock:
            tmp = META_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=1)
            os.replace(tmp, META_PATH)

    def session(self, sid):
        return self.data["sessions"].setdefault(sid, {})

    def update(self, sid, **fields):
        self.session(sid).update(fields)
        if "group" in fields and fields["group"] and fields["group"] not in self.data["groups"]:
            self.data["groups"].append(fields["group"])
        self.save()

    def add_folder(self, folder):
        folders = [f for f in self.data["recent_folders"] if os.path.normcase(f) != os.path.normcase(folder)]
        self.data["recent_folders"] = [folder] + folders[:11]
        self.save()

    def set_workspace(self, folder, present):
        ws = [f for f in self.data["workspaces"] if not same_folder(f, folder)]
        self.data["workspaces"] = ws + [folder] if present else ws
        self.save()


# --- transcript items -------------------------------------------------------------------------------------------
def result_text(content):
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(c.get("text", "") if isinstance(c, dict) else str(c) for c in content)
    else:
        text = "" if content is None else str(content)
    return text if len(text) <= RESULT_PREVIEW else text[:RESULT_PREVIEW] + f"\n… ({len(text) - RESULT_PREVIEW} more)"


def block_get(b, key, default=None):
    return b.get(key, default) if isinstance(b, dict) else getattr(b, key, default)


def result_images(content):
    """(media_type, base64) of the images in a tool result (screen-control screenshots, Read of an image)."""
    out = []
    for b in content if isinstance(content, list) else []:
        if block_get(b, "type") == "image":
            src = block_get(b, "source") or {}
            if block_get(src, "type") == "base64" and block_get(src, "data"):
                out.append((block_get(src, "media_type", "image/png"), block_get(src, "data")))
    return out


def thumbnail(data_b64, width=480):
    """A small JPEG data: URL of an image, for the transcript (full screenshots would bloat it)."""
    from PIL import Image
    try:
        img = Image.open(io.BytesIO(base64.b64decode(data_b64)))
        img.thumbnail((width, width * 3))
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "JPEG", quality=70)
        return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        log.debug("thumbnail failed: %s", e)
        return None


def save_image(sid, media_type, data_b64):
    """Keep a pasted image on disk (named by its content) so it stays viewable in the conversation."""
    ext = {"image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp"}.get(media_type, "png")
    raw = base64.b64decode(data_b64)
    folder = os.path.join(ATTACH_DIR, sid)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, hashlib.sha1(raw).hexdigest()[:16] + "." + ext)
    if not os.path.exists(path):
        with open(path, "wb") as f:
            f.write(raw)
    return path


def is_noise(text):
    """Claude Code bookkeeping that isn't part of the conversation."""
    t = text.lstrip()
    return t.startswith(("<command-", "<local-command", "Caveat:", "<system-reminder", "[Request interrupted"))


async def spoken_line(title, asked, reply, short_version=False):
    """One short line to say out loud about a reply, and the mood to show while saying it: (line, mood). From a
    separate quick Claude call that isn't saved anywhere (no session, no tools), so none of this prompting shows in the
    conversation or adds to its context."""
    if short_version:
        task = ("Say the short version of Claude's message below, out loud, in one or two sentences (at most 35 "
                "words): the gist and anything it asks the user. Plain spoken English: no markdown, paths or code.")
    else:
        task = ("Claude just finished replying in the session below and is now waiting for the user, who may be away "
                "from the screen. Write ONE short spoken sentence (at most 20 words) to tell them: start with the "
                "session's short name, then the single most useful thing (the outcome, or the question it's asking). "
                "Not a summary of everything. Plain spoken English: no markdown, paths or code.")
    prompt = (f"{task} Say it in her voice (see below): most lines get a light, natural touch of personality (a wry "
              f"aside, a little warmth); the facts and the session's name stay exactly as given. Pick the mood her face shows while she says it.\n\n"
              f"Session: {title}\n\nWhat the user asked:\n{(asked or '')[:1500]}\n\n"
              f"Claude's message:\n{(reply or '')[:6000]}\n\n"
              f"Reply with JSON only: {{\"line\": \"...\", \"mood\": one of {sorted(MOODS)}}}")
    opts = sdk.ClaudeAgentOptions(model=VOICE_NOTE_MODEL, tools=[], cwd=CHAT_DIR, setting_sources=["project"],
                                  max_turns=1, thinking={"type": "disabled"},
                                  system_prompt="You write very short spoken lines for a voice assistant. " + PERSONA,
                                  extra_args={"no-session-persistence": None})
    text = ""
    async for m in sdk.query(prompt=prompt, options=opts):
        if isinstance(m, sdk.AssistantMessage):
            text += "".join(b.text for b in m.content if isinstance(b, sdk.TextBlock))
    try:   # JSON, possibly in a code fence; if not, the whole text is the line
        data = json.loads(re.search(r"\{.*\}", text, re.S).group(0))
        line, mood = str(data.get("line", "")), str(data.get("mood", ""))
    except (AttributeError, ValueError):
        line, mood = text, ""
    return " ".join(line.split()).strip(' "'), (mood if mood in MOODS else "")


async def suggest_next(title, asked, reply):
    """A likely next message from the user (grey in the empty message box, Tab takes it), from the same kind of quick
    separate call as spoken_line: nothing saved, nothing in the chat. "" when nothing sensible comes to mind."""
    asked = re.sub(r"^\[voice\]\s*", "", (asked or "").strip())
    reply = (reply or "").strip()
    reply = reply if len(reply) <= 4000 else "…" + reply[-4000:]   # the end is where questions and options are
    prompt = ("Below is the last exchange in a conversation between a user and Claude (an AI assistant). Guess the "
              "user's most likely next message to Claude, written as the user would type it: short (at most 15 words), "
              "plain text, first person. If Claude asked a question, give a natural answer to it. If Claude offered "
              "options or a next step, pick the likely one (for example \"Yes, do it\" or \"Go with option 2\"). "
              "Never make up facts, names, numbers or details the user hasn't given. If no sensible guess fits, "
              "reply NONE.\n\n"
              f"Session: {title}\n\nWhat the user asked:\n{asked[:1500]}\n\nClaude's reply:\n{reply}\n\n"
              "Reply with the user's next message only, or NONE.")
    opts = sdk.ClaudeAgentOptions(model=VOICE_NOTE_MODEL, tools=[], cwd=CHAT_DIR, setting_sources=["project"],
                                  max_turns=1, thinking={"type": "disabled"},
                                  system_prompt="You predict what a user will type next to their AI assistant.",
                                  extra_args={"no-session-persistence": None})
    text = ""
    async for m in sdk.query(prompt=prompt, options=opts):
        if isinstance(m, sdk.AssistantMessage):
            text += "".join(b.text for b in m.content if isinstance(b, sdk.TextBlock))
    line = " ".join((text.strip().splitlines() or [""])[0].split()).strip(' "“”\'`')
    if not line or line.rstrip(".").upper() == "NONE" or len(line.split()) > 20:
        return ""
    return line


async def suggest_followup(title, asked):
    """While Claude works on your message: a follow-up you might queue, guessed from that message alone (quick and
    cheap, the same kind of separate call as suggest_next). \"\" when nothing sensible comes to mind."""
    prompt = ("The user just sent the message below to Claude (an AI assistant), which is now working on it. Guess one "
              "short follow-up the user might want to queue up, to send once Claude has answered: a natural next step "
              "(for example \"Then commit it\", \"Also add a test for it\", \"Show me the diff when you're done\"). "
              "Write it as the user would type it: at most 12 words, plain text, first person. Never make up facts, "
              "names, numbers or details the user hasn't given. If nothing sensible fits, reply NONE.\n\n"
              f"Session: {title}\n\nThe user's message:\n{(asked or '')[:1200]}\n\n"
              "Reply with the follow-up only, or NONE.")
    opts = sdk.ClaudeAgentOptions(model=VOICE_NOTE_MODEL, tools=[], cwd=CHAT_DIR, setting_sources=["project"],
                                  max_turns=1, thinking={"type": "disabled"},
                                  system_prompt="You predict what a user will type next to their AI assistant.",
                                  extra_args={"no-session-persistence": None})
    text = ""
    async for m in sdk.query(prompt=prompt, options=opts):
        if isinstance(m, sdk.AssistantMessage):
            text += "".join(b.text for b in m.content if isinstance(b, sdk.TextBlock))
    line = " ".join((text.strip().splitlines() or [""])[0].split()).strip(' "“”\'`')
    if not line or line.rstrip(".").upper() == "NONE" or len(line.split()) > 16:
        return ""
    return line


ADVISOR_PROMPT = (
    " When you consult the advisor (the advisor tool), Yo Claude shows it to the user as a third member of the chat, "
    "but the advisor's reply itself never reaches their screen. So straight after each advisor reply, before "
    "anything else, pass it on in a block of its own: <advisor>its advice, faithfully, in plain words and in its own "
    "voice (\"Check X before you Y\"): a few short sentences or a short list, keeping its specific warnings and "
    "recommendations</advisor>. Then carry on as usual, without repeating it."
)
ADVISOR_BLOCK = re.compile(r"<advisor>\s*(.*?)\s*</advisor>\s*", re.S)   # the advisor's reply, passed on by Claude


TIDY_KEEP = re.compile(r"`[^`\n]+`|@\S+|https?://\S+|[A-Za-z]:[\\/]\S+")   # must come back exactly as they were


async def tidy_text(text, context=""):
    """Your message with its spelling, grammar and punctuation fixed (and, for speech, words that were obviously
    misheard), from the same kind of quick separate call as spoken_line: nothing saved, nothing in the chat. Your
    words, meaning and tone stay; it never answers. Returns the text unchanged when there's nothing to fix or the fix
    looks wrong (much longer or shorter, or a path, @file, link or `code` changed)."""
    text = (text or "").strip()
    if len(text.split()) < 2 or text.startswith("/"):
        return text
    context = (context or "").strip()
    context = context if len(context) <= 1500 else "…" + context[-1500:]
    prompt = ("Fix the spelling, grammar and punctuation of the user's message in <message> tags below. They're about "
              "to send it to Claude, an AI assistant. It may have been spoken and transcribed by speech recognition: "
              "also fix words that were obviously misheard, using the conversation so far. The assistant is called "
              "Claude (the app is Yo Claude), so a name that sounds like it (\"Clyde\", \"Lord\", \"Cloud\") means "
              "Claude. Keep their words, meaning, tone and language: don't rephrase, shorten, "
              "expand, translate or answer it, even if it's a question or an instruction. Leave code, file paths, "
              "commands, @file mentions, links, names and technical terms exactly as they are. Reply with the "
              "corrected message only, with no tags or comments. If nothing needs fixing, reply with it unchanged.\n\n"
              + (f"Claude's last message, for context:\n{context}\n\n" if context else "")
              + f"<message>\n{text}\n</message>")
    opts = sdk.ClaudeAgentOptions(model=VOICE_NOTE_MODEL, tools=[], cwd=CHAT_DIR, setting_sources=["project"],
                                  max_turns=1, thinking={"type": "disabled"},
                                  system_prompt="You proofread messages before they're sent. You only ever return the "
                                                "corrected message.",
                                  extra_args={"no-session-persistence": None})
    out = ""
    async for m in sdk.query(prompt=prompt, options=opts):
        if isinstance(m, sdk.AssistantMessage):
            out += "".join(b.text for b in m.content if isinstance(b, sdk.TextBlock))
    out = re.sub(r"^\s*<message>\s*|\s*</message>\s*$", "", out.strip()).strip()
    if not out or not 0.6 <= len(out) / len(text) <= 1.5 and abs(len(out) - len(text)) > 12:
        return text
    if any(k not in out for k in TIDY_KEEP.findall(text)):
        return text
    return out


BTW_PROMPT = (
    " This is a side question (\"btw\") about the conversation above, asked in a separate side chat. Nothing said "
    "here is added to the main conversation, which may still be going on. Answer briefly and directly from what has "
    "been said and done so far. You can only look (read files, search), not change anything; if the answer needs "
    "changes or commands, say so and leave them for the main conversation. If the last request above has no reply "
    "yet (or a placeholder one), Claude is most likely still working on it in the main conversation: don't apologise "
    "for it or offer to do it here."
)
BTW_BUSY_NOTE = ("(Note: Claude is still working on the last request in the main conversation; that reply isn't "
                 "shown here yet. Don't apologise for it or offer to redo it.)\n\n")


async def side_chat(sid, cwd, questions, emit, model=None, mark=None, extra_dirs=(), settings=None, live=None):
    """A /btw side chat about session `sid`: a fork of it (resume + fork_session) that Claude Code never saves
    (--no-session-persistence), so it sees everything said and done so far, but none of it lands in the session's
    transcript, its later context or the session list. Read-only: Read/Grep/Glob and the web tools at most.
    Questions come from the asyncio queue `questions` (None ends it); follow-ups go to the same live connection, so
    they keep the side thread. emit(state, text) reports: "delta" (answer text streaming in), "tool" (what it's
    looking at), "done" (the whole answer), "error". `live` (a dict) gets the connection as "client"; once its
    "closed" is set, no further question is asked."""
    live = {} if live is None else live
    tools = (READ_TOOLS if cwd or extra_dirs else []) + WEB_TOOLS

    async def read_only(tool, inp, ctx):   # tools= already leaves out everything else; this is the second lock
        if tool in tools:
            return sdk.PermissionResultAllow()
        return sdk.PermissionResultDeny(message="This is a read-only side chat.", interrupt=False)

    opts = dict(
        cwd=cwd or CHAT_DIR, resume=sid, fork_session=True, tools=tools, can_use_tool=read_only,
        permission_mode="default", include_partial_messages=True, strict_mcp_config=True, mcp_servers={},
        setting_sources=["user", "project", "local"] if cwd else ["project", "local"],
        system_prompt={"type": "preset", "preset": "claude_code", "append": BTW_PROMPT},
        thinking={"type": "disabled"}, stderr=lambda line: log.debug("claude (btw): %s", line.rstrip()),
        extra_args={"no-session-persistence": None},
    )
    if settings:
        opts["settings"] = settings
    if model:
        opts["model"] = model
    if mark:   # the session was rewound: ask about the conversation as you see it
        opts.update(resume_session_at=mark["at"], resume_drops_turn=mark["drop"])
    if extra_dirs:
        opts["add_dirs"] = list(extra_dirs)
    fork = None
    try:
        async with sdk.ClaudeSDKClient(options=sdk.ClaudeAgentOptions(**opts)) as client:
            live["client"] = client
            while True:
                question = await questions.get()
                if question is None or live.get("closed"):
                    break
                live["answering"] = True
                await client.query(question)
                parts, error = [], None
                async for m in client.receive_response():
                    if isinstance(m, sdk.SystemMessage) and m.subtype == "init":
                        fork = (m.data or {}).get("session_id") or fork
                    if isinstance(m, sdk.StreamEvent) and not m.parent_tool_use_id:
                        fork = m.session_id or fork
                        ev = m.event or {}
                        if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                            emit("delta", ev["delta"]["text"])
                    elif isinstance(m, sdk.AssistantMessage) and not m.parent_tool_use_id:
                        for b in m.content:
                            if isinstance(b, sdk.TextBlock) and b.text.strip():
                                parts.append(b.text)
                            elif isinstance(b, sdk.ToolUseBlock) and b.name in tools:   # others just fail
                                emit("tool", approval_summary(b.name, b.input or {}))
                    elif isinstance(m, sdk.ResultMessage):
                        fork = m.session_id or fork
                        if m.is_error:
                            error = m.result or "Claude couldn't answer that."
                live["answering"] = False
                if error and not parts:
                    emit("error", str(error))
                else:
                    emit("done", "\n\n".join(parts))
    except asyncio.CancelledError:
        raise
    except Exception as e:
        log.warning("btw side chat for %s failed: %s", sid, e)
        emit("error", f"The side chat stopped: {e}")
    finally:
        # forking copies the session's file checkpoints under the fork's id; the fork is gone, so they can go too
        if fork and fork != sid and re.fullmatch(r"[0-9a-f-]{36}", fork):
            shutil.rmtree(os.path.join(os.path.expanduser("~"), ".claude", "file-history", fork), ignore_errors=True)


def system_note(text):
    """Notices stored in the transcript as if you'd typed them: background-task reports (<task-notification>) and
    Yo Claude's own follow-ups ("[Yo Claude] ..."). Returns the note to show instead of your bubble, or None."""
    t = text.lstrip()
    if "<task-notification>" in t[:400]:
        tag = lambda name: (re.search(rf"<{name}>(.*?)</{name}>", t, re.S) or [None, ""])[1].strip()
        status = tag("status") or "update"
        what = tag("summary") or tag("output-file") or tag("task-id")
        return f"Background task {status}" + (f": {what}" if what else "")
    if t.startswith("[Yo Claude] "):
        return "Yo Claude: " + t[len("[Yo Claude] "):].strip()
    return None


def approval_summary(tool, inp):
    """What Claude wants to do, said in a few words (for the card and for voice)."""
    path = inp.get("file_path") or inp.get("notebook_path") or inp.get("path") or ""
    name = os.path.basename(path) if path else ""
    if tool in ("Bash", "PowerShell"):
        return "run: " + (inp.get("description") or inp.get("command", ""))[:120]
    if tool in ("Edit", "MultiEdit", "NotebookEdit"):
        return f"edit {name}"
    if tool == "Write":
        return f"write {name}"
    if tool == "WebFetch":
        return "fetch " + re.sub(r"^https?://([^/]+).*", r"\1", inp.get("url", ""))
    if tool.startswith("mcp__"):
        server, _, action = tool[5:].partition("__")
        return f"use {server}: {action.replace('_', ' ')}"
    return f"use {tool}"


class Session:
    """One conversation: its transcript, live SDK connection and pending approvals."""

    def __init__(self, router, cwd, sid=None, resumed=False):
        self.router = router
        self.cwd = cwd                      # None = chat
        self.id = sid or str(uuid.uuid4())
        self.resumed = resumed              # an existing Claude Code session (pass resume=, not session_id=)
        self.items = []
        self.client = None
        self.busy = False
        self.permission_mode = "auto"       # always the default; changing it is per session
        self.extra_dirs = [d for d in router.meta.session(self.id).get("extra_dirs", []) if os.path.isdir(d)]
        self.model = router.settings.get("model") or None     # None = your Claude Code default (chats: CHAT_MODEL)
        self.effort = router.settings.get("effort") or None
        self.approvals = {}                 # approval id -> asyncio future
        self.always = set()                 # tools allowed for the rest of this session
        self.voice_turn = False
        self.picked = False                 # chosen in the app: voice keeps talking to it however old it is
        self.baseline = None                # workspace snapshot the changes panel compares with
        self.baseline_kind = None           # "start" (made here) or "opened" (an older session opened now)
        self.touched = []                   # files Claude's tools changed (for folders that aren't git repos)
        self.stream_item = None
        self.think_item = None              # the thought streaming in now (the thinking bubble)
        self.last_used = time.time()
        self.cost_seen = 0.0                # Claude Code's running cost total for this session, as last seen
        self.lock = None                    # asyncio.Lock, made on the loop
        self.reader = None                  # the task reading everything Claude sends
        self.turn_future = None             # resolved with Claude's reply to the message being sent
        self.waiting = {}                   # queued message index -> (prompt, its text): what "send now" sends
        self.order = []                     # queued messages (indexes), in the order they go: you can drag them
        self.injected = []                  # [(item, text)] sent now into the reply in progress, not yet taken up
        self.joined = {}                    # sent-now message index -> the turn future of the reply it joined
        self.holding = False                # that reply ended, but Claude still has a sent-now message to answer
        self.heard = 0                      # messages from Claude Code so far (a held reply lets go if this stops)
        self.unsolicited = False            # Claude is replying by itself (a background task finished)
        self.turn_count = 0                 # turns started (a suggested next message is dropped if another began)
        self.tasks = {}                     # background task id -> its transcript item
        self.task_outputs = {}              # tool_use_id -> output file (named in the tool result)
        self.pid = None                     # this session's claude.exe
        self.context = None                 # context window usage, measured after each reply
        self.loading_history, self.history_ts = False, None   # items from history carry their message's time

    @property
    def mode(self):
        return "code" if self.cwd else "chat"

    def add(self, item):
        if "ts" not in item:
            item["ts"] = self.history_ts if self.loading_history else time.time()
        item["i"] = len(self.items)
        self.items.append(item)
        self.router.emit("item", session=self.id, item=item)
        return item

    def changed(self, item):
        self.router.emit("item", session=self.id, item=item)

    def advisor_said(self, text):
        """Claude's text minus any <advisor> block: the advisor's reply, passed on (ADVISOR_PROMPT). That goes in the
        advisor's bubble instead: the latest one since your last message still waiting for it, or a new one."""
        if "<advisor>" not in text:
            return text
        for advice in ADVISOR_BLOCK.findall(text):
            item = None
            for x in reversed(self.items):
                if x.get("kind") == "user":
                    break
                if x.get("kind") == "advisor" and not x.get("text"):
                    item = x
                    break
            if item is None:
                item = self.add({"kind": "advisor", "text": "", "status": "heard"})
            item.update(text=advice, status="done")
            self.changed(item)
        return ADVISOR_BLOCK.sub("", text).strip()

    def tool_item(self, tool_id):
        for item in reversed(self.items):
            if item.get("kind") == "tool" and item.get("id") == tool_id:
                return item
        return None

    def load_history(self):
        """Transcript of an existing session, from its JSONL."""
        try:
            messages = sdk.get_session_messages(self.id, directory=self.cwd or CHAT_DIR)
        except Exception as e:
            log.warning("Couldn't read session %s: %s", self.id, e)
            return
        mark = self.rewind_mark()
        stamps = message_times(self.router.session_file(self.id, self.cwd)[1])
        self.folded = folded_prompts(self.router.session_file(self.id, self.cwd)[1])
        self.loading_history = True
        try:
            self.load_messages(messages, mark, stamps)
        finally:
            self.loading_history, self.history_ts, self.folded = False, None, {}
        self.restore_spoken()

    def load_messages(self, messages, mark, stamps):
        for m in messages:
            self.history_ts = stamps.get(m.uuid)
            if mark and m.uuid == mark["drop"]:   # rewound here (until the next message makes the new branch)
                break
            msg = m.message if isinstance(m.message, dict) else {}
            role, content = msg.get("role"), msg.get("content")
            if m.parent_tool_use_id:   # subagent internals
                continue
            first_user = role == "user" and not any(i.get("uuid") == m.uuid for i in self.items[-3:])
            blocks = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
            for b in blocks:
                if not isinstance(b, dict):
                    continue
                t = b.get("type")
                if t == "text" and role == "user" and system_note(b.get("text", "")):
                    self.add({"kind": "note", "text": system_note(b["text"])})
                elif t == "server_tool_use" and b.get("name") == "advisor":
                    self.add({"kind": "advisor", "id": b.get("id"), "text": "", "status": "heard"})
                elif t == "text" and b.get("text", "").strip() and not is_noise(b["text"]):
                    text = self.advisor_said(b["text"]) if role == "assistant" else b["text"]
                    if not text.strip():
                        continue
                    voice = role == "user" and text.startswith("[voice] ")
                    attachments = []
                    if role == "user":   # attached files go back to chips, as they were when sent
                        attachments = re.findall(r'<attached_file path="([^"]+)">', text)
                        attachments += re.findall(r"^Attached file \(read it as needed\): (.+)$", text, flags=re.M)
                        text = re.sub(r'\s*<attached_file path="[^"]+">.*?</attached_file>', "", text, flags=re.S)
                        text = re.sub(r"\s*^Attached file \(read it as needed\): .+$", "", text, flags=re.M).strip()
                    item = self.add({"kind": role if role in ("user", "assistant") else "assistant",
                                     "text": text[8:] if voice else text, "voice": voice, "attachments": attachments})
                    if role == "user" and first_user:
                        item["uuid"], first_user = m.uuid, False
                elif t == "image" and role == "user":   # a pasted image: back as a viewable picture
                    pics = result_images([b])
                    if pics:
                        last = self.items[-1] if self.items and self.items[-1]["kind"] == "user" else None
                        if last is None:
                            last = self.add({"kind": "user", "text": "", "attachments": []})
                        last.setdefault("image_paths", []).append(save_image(self.id, *pics[0]))
                elif t == "thinking" and b.get("thinking"):
                    self.add({"kind": "thinking", "text": b["thinking"]})
                elif t == "tool_use" and b.get("name") == f"mcp__{UI_SERVER}__checklist":   # its card, as it was
                    inp = b.get("input") or {}
                    self.add({"kind": "checklist", "id": b.get("id"), "title": inp.get("title") or "",
                              "items": [str(x) for x in inp.get("items") or []], "status": "past"})
                elif t == "tool_use":
                    self.add({"kind": "tool", "id": b.get("id"), "name": b.get("name"), "input": b.get("input", {}),
                              "result": None, "status": "done"})
                elif t == "tool_result":
                    item = self.tool_item(b.get("tool_use_id"))
                    if item:
                        item["result"] = result_text(b.get("content"))
                        item["status"] = "error" if b.get("is_error") else "done"
                        pics = result_images(b.get("content"))
                        if pics:
                            item["image"] = thumbnail(pics[-1][1])
            for uid, text in getattr(self, "folded", {}).get(m.uuid, ()):   # sent while Claude worked (send now)
                self.history_ts = stamps.get(uid)
                if system_note(text):
                    self.add({"kind": "note", "text": system_note(text)})
                    continue
                voice = text.startswith("[voice] ")
                self.add({"kind": "user", "text": text[8:] if voice else text, "voice": voice, "attachments": []})

    # --- SDK plumbing ---
    def options(self):
        r = self.router
        system = CODE_PROMPT if self.cwd else CHAT_PROMPT
        servers = r.mcp_servers(self.cwd)
        if PC_CONTROL_SERVER in servers:
            system += PC_CONTROL_PROMPT
        servers[UI_SERVER] = self.ui_tools()
        system += UI_PROMPT   # (the Options menu: tick lists, advisor notes; from the session's next start)
        if r.settings.get("checklist_tool", True):
            system += CHECKLIST_PROMPT
        if r.settings.get("advisor_relay", True):
            system += ADVISOR_PROMPT
        opts = dict(
            cwd=self.cwd or CHAT_DIR,
            can_use_tool=self.can_use_tool,
            permission_mode=self.permission_mode,
            include_partial_messages=True,
            settings=json.dumps(r.loadout_settings()),
            strict_mcp_config=True,
            mcp_servers=servers,
            system_prompt={"type": "preset", "preset": "claude_code", "append": system},
            stderr=lambda line: log.debug("claude: %s", line.rstrip()),
            extra_args={"replay-user-messages": None},   # prompts come back with their message id (for rewind)
            thinking={"type": "adaptive", "display": "summarized"},   # its thinking as readable text, for the bubble
        )
        if self.resumed:
            opts["resume"] = self.id
            mark = self.rewind_mark()
            if mark:   # rewound: carry on from before the dropped message (a new branch of the same session)
                opts.update(resume_session_at=mark["at"], resume_drops_turn=mark["drop"])
        else:
            opts["session_id"] = self.id
        if self.cwd:
            opts.update(setting_sources=["user", "project", "local"], enable_file_checkpointing=True)
        else:
            # not [] - the SDK sends that as an empty --setting-sources, which loads everything. CHAT_DIR has no
            # project settings, so this leaves out your user settings (skills, plugins: ~10k tokens a question).
            # A chat given extra folders also gets the file tools, so it can work in them.
            tools = WEB_TOOLS + (FILE_TOOLS if self.extra_dirs else [])
            opts.update(setting_sources=["project", "local"], tools=tools, allowed_tools=list(WEB_TOOLS),
                        model=CHAT_MODEL)
        if self.extra_dirs:   # more folders Claude may read and write, besides the main one
            opts["add_dirs"] = list(self.extra_dirs)
        if self.model:
            opts["model"] = self.model
        if self.effort:
            opts["effort"] = self.effort
        return sdk.ClaudeAgentOptions(**opts)

    def ui_tools(self):
        """Tools for Claude to show things in Yo Claude's window: they only act while this session is the one
        open there (otherwise they say so), so a session working in the background can't pull the view away."""
        sess = self

        def reply(text):
            return {"content": [{"type": "text", "text": text}]}

        def act(action, **args):
            return reply(sess.router.ui_action(sess, action, **args))

        @sdk.tool("show_folder", "Open the files panel in Yo Claude's window at a folder (expanded, highlighted), so "
                  "the user can see it. Path: absolute, or relative to the session folder.", {"path": str})
        async def show_folder(a):
            return act("folder", path=a.get("path", ""))

        @sdk.tool("show_file", "Open a file in Yo Claude's viewer for the user to see (text, Markdown, pictures, "
                  "video, PDF). Path: absolute, or relative to the session folder.", {"path": str})
        async def show_file(a):
            return act("file", path=a.get("path", ""))

        @sdk.tool("show_diff", "Show the user what changed in a file in this session (the changes panel's diff).",
                  {"path": str})
        async def show_diff(a):
            return act("diff", path=a.get("path", ""))

        @sdk.tool("show_panel", "Show a tab of the right-hand panel: files, changes, git or tasks (or 'close').",
                  {"tab": str})
        async def show_panel(a):
            return act("panel", tab=a.get("tab", "files"))

        @sdk.tool("checklist", "Give the user a list to tick in Yo Claude's window: each item is a yes (ticked) or a no, "
                  "they can say why for any item, and add a note. Their answers come as their next message, so end your "
                  "reply after calling it. "
                  "Use it whenever they should pick several things from a list (which to do, keep, include, fix).",
                  {"type": "object", "properties": {
                      "title": {"type": "string", "description": "What they're choosing, as a short question"},
                      "items": {"type": "array", "items": {"type": "string"}, "description": "The options, one line each"},
                      "checked": {"type": "array", "items": {"type": "string"},
                                  "description": "Optional: items ticked to start with (your recommendation)"}},
                   "required": ["title", "items"]})
        async def checklist(a):
            return reply(await sess.checklist(a))

        @sdk.tool("queue_message", "Queue a message to yourself in this session: it's sent as the user's next message once "
                  "your current reply is done, after any they queued, and kept across a Yo Claude restart (sent when the "
                  "session is next opened). Use it when the user asks you to do something later or after a restart.",
                  {"text": str})
        async def queue_message(a):
            text = " ".join(str(a.get("text") or "").split()) and str(a.get("text")).strip()
            if not text:
                return reply("Nothing to queue.")
            sess.router.send(text, sid=sess.id, queued_by="claude")
            return reply("Queued: it goes after your current reply (and survives a restart).")

        tools = [show_folder, show_file, show_diff, show_panel, queue_message]
        if sess.router.settings.get("checklist_tool", True):
            tools.append(checklist)
        return sdk.create_sdk_mcp_server(UI_SERVER, tools=tools)

    async def can_use_tool(self, tool, inp, ctx):
        if tool.startswith(f"mcp__{UI_SERVER}__"):   # only shows things in the window
            return sdk.PermissionResultAllow()
        if tool.startswith(f"mcp__{PC_CONTROL_SERVER}__"):
            self.router.set_work(self, "using_pc")
            return sdk.PermissionResultAllow()   # turned on deliberately from the tray
        if tool == "AskUserQuestion":            # never auto-allowed: it needs the user's answers
            return await self.ask_user(inp)
        if tool in self.always or (self.cwd is None and tool in WEB_TOOLS):
            return sdk.PermissionResultAllow()
        aid = uuid.uuid4().hex[:12]
        future = asyncio.get_running_loop().create_future()
        self.approvals[aid] = future
        summary = approval_summary(tool, inp)
        item = self.add({"kind": "approval", "id": aid, "tool": tool, "input": inp, "summary": summary,
                         "title": getattr(ctx, "title", None) or "", "status": "pending"})
        self.router.set_work(self, "awaiting_approval")
        if self.voice_turn and self.router.on_voice_approval:
            self.router.on_voice_approval(self.id, aid, summary)
        try:
            allow, always = await future
        finally:
            self.approvals.pop(aid, None)
        item["status"] = "allowed" if allow else "denied"
        self.changed(item)
        self.router.set_work(self, "thinking")
        if not allow:
            return sdk.PermissionResultDeny(message="The user declined this.", interrupt=False)
        if always:
            self.always.add(tool)
        return sdk.PermissionResultAllow()

    def save_pending(self):
        """Your queued messages, kept in the session's details so a restart doesn't lose them: they're sent again,
        in the same order, when the session is next opened (Router.open). Their text and attached files (not pasted
        pictures)."""
        pend = []
        for i in self.order if self.router.settings.get("keep_queue", True) else []:
            it = self.items[i]
            if it.get("kind") == "user" and it.get("queued") and not it.get("cancelled") and not it.get("sent_now"):
                pend.append({"text": it.get("text", ""), "attachments": list(it.get("attachments") or [])})
        if pend or self.router.meta.session(self.id).get("pending"):
            self.router.meta.update(self.id, pending=pend)

    async def checklist(self, a):
        """Claude's checklist tool: shows a card you tick (yes or no for each item, why for any of them, a note) and
        returns at once, so Claude's reply ends there. Your answers go to Claude as your next message when you click
        [submit] (Router.checklist_answer)."""
        title = " ".join(str(a.get("title") or "").split()) or "Pick from the list"
        items = [" ".join(str(x).split()) for x in a.get("items") or [] if str(x).strip()][:80]
        if not items:
            return "There were no items to show."
        pre = {" ".join(str(x).split()) for x in a.get("checked") or []}
        self.add({"kind": "checklist", "id": uuid.uuid4().hex[:12], "title": title, "items": items,
                  "checked": [x for x in items if x in pre], "status": "pending"})
        return ("Shown to the user as a checklist. Their answers (yes or no for each item, maybe with reasons) will come "
                "as their next message. End your reply here, without writing the list out again.")

    async def ask_user(self, inp):
        """Claude's AskUserQuestion: show the questions as a card and hand the answers back to the tool.
        Claude Code takes them as updated input: answers = {question text: chosen label (or typed text)}, a list of
        labels for a multiSelect question. Skipping (or stopping) denies the tool so Claude carries on without."""
        questions = [q for q in inp.get("questions") or [] if isinstance(q, dict) and q.get("question")]
        aid = uuid.uuid4().hex[:12]
        future = asyncio.get_running_loop().create_future()
        self.approvals[aid] = future             # with the approvals, so stopping the turn also skips it
        item = self.add({"kind": "question", "id": aid, "questions": questions, "status": "pending"})
        self.router.set_work(self, "awaiting_approval")
        try:
            got = await future                   # dict of answers, or anything else (None, an approval tuple) = skip
        finally:
            self.approvals.pop(aid, None)
        answers = {}
        if isinstance(got, dict):
            for q in questions:
                a = got.get(q["question"])
                if q.get("multiSelect") and isinstance(a, list):
                    a = [str(x).strip() for x in a if str(x).strip()]
                elif isinstance(a, list):
                    a = ", ".join(str(x).strip() for x in a if str(x).strip())
                elif isinstance(a, str):
                    a = a.strip()
                if a:
                    answers[q["question"]] = a
        item["status"] = "answered" if answers else "skipped"
        item["answers"] = answers
        self.changed(item)
        self.router.set_work(self, "thinking")
        if not answers:
            return sdk.PermissionResultDeny(message="The user didn't answer the question; carry on without it.",
                                            interrupt=False)
        return sdk.PermissionResultAllow(updated_input={**inp, "answers": answers})

    async def connect(self):
        if self.client is None:
            self.client = sdk.ClaudeSDKClient(options=self.options())
            # Claude Code's cost total covers the whole session, earlier connections included: start from the total
            # Yo Claude last saw for it (None when it doesn't know, e.g. a session also used elsewhere)
            self.cost_seen = 0.0 if not self.resumed else self.router.meta.session(self.id).get("cost_total")
            await self.client.connect()
            try:   # remembered with background tasks, so a restart can tell whether they're still going
                self.pid = self.client._transport._process.pid
            except Exception:
                self.pid = None
            self.reader = asyncio.ensure_future(self.read_loop(self.client))
            self.router.evict(keep=self)
            asyncio.ensure_future(self.learn_commands())

    def loading_history_flag(self):
        return bool(getattr(self, "loading_history", False))

    def last_exchange(self, upto=None):
        """(index of Claude's last message, its text, what you asked before it), up to item `upto`."""
        items = self.items[:upto + 1] if upto is not None else self.items
        reply = next((i for i in reversed(items) if i.get("kind") == "assistant" and i.get("text", "").strip()), None)
        if not reply:
            return None, "", ""
        asked = next((i for i in reversed(self.items[:reply["i"]]) if i.get("kind") == "user"), None)
        return reply["i"], reply["text"], (asked or {}).get("text", "")

    async def announce(self, speak=True):
        """Claude is done and waiting for you: her reaction. Says so in one short line, shown as a voice bubble (not
        after a voice request: that reply is read out already), and her face shows the mood that fits."""
        st = self.router.settings
        speak = speak and st.get("notify_done", True) and st.get("voice_replies", True)
        if not speak and st.get("avatar") is False:
            return
        i, reply, asked = self.last_exchange()
        if i is None or any(x.get("kind") == "spoken" and x.get("for") == i for x in self.items):
            return
        try:
            line, mood = await spoken_line(self.router.title_of(self.id), asked, reply)
        except Exception as e:
            log.warning("Couldn't write the spoken note for %s: %s", self.id, e)
            return
        if mood:
            self.router.emit("mood", session=self.id, mood=mood, clip=MOODS[mood])
        if line and speak:
            self.add_spoken(i, line, say=True)

    def turn_started(self):
        """A new turn (yours, or Claude carrying on by itself): any suggested next message is out of date."""
        self.turn_count += 1
        self.router.emit("suggest", session=self.id, text="")

    async def suggest(self, n):
        """After Claude's reply: a likely next message from you, shown grey in the empty message box (Tab takes it).
        `n` is the turn it's for: dropped if another turn has started since, or the reply ended in an error."""
        if not self.router.settings.get("suggest_next", True):
            return
        last_user = max((x["i"] for x in self.items if x.get("kind") == "user"), default=-1)
        if any(x.get("kind") == "error" or (x.get("kind") == "result" and x.get("error"))
               for x in self.items[last_user + 1:]):
            return self.unsuggest(n)
        i, reply, asked = self.last_exchange()
        if i is None or i < last_user:   # no reply to your last message
            return self.unsuggest(n)
        try:
            text = await suggest_next(self.router.title_of(self.id), asked, reply)
        except Exception as e:
            log.warning("Couldn't suggest a next message for %s: %s", self.id, e)
            text = ""
        if self.turn_count == n:   # (none: the guess made while Claude worked goes too, it's out of date)
            self.router.emit("suggest", session=self.id, text=text)

    def unsuggest(self, n):
        if self.turn_count == n:
            self.router.emit("suggest", session=self.id, text="")

    async def suggest_early(self, n, asked):
        """While Claude works on your message: a follow-up you might queue (grey in the empty box, Tab takes it,
        Enter queues it), from your message alone. suggest() replaces it once the reply is in."""
        st = self.router.settings
        if not st.get("suggest_next", True) or not st.get("suggest_early", True) or not (asked or "").strip():
            return
        try:
            text = await suggest_followup(self.router.title_of(self.id), asked)
        except Exception as e:
            log.info("Couldn't suggest a follow-up for %s: %s", self.id, e)
            return
        if text and self.turn_count == n and self.busy:   # (the reply's in already: suggest() has it)
            self.router.emit("suggest", session=self.id, text=text)

    def add_spoken(self, i, line, say):
        """A voice bubble under Claude's message `i` (kept in Yo Claude's notes, so it's there after a restart)."""
        self.add({"kind": "spoken", "text": line, "for": i, "ts": time.time()})
        notes = self.router.meta.session(self.id).get("spoken") or []
        key = hashlib.sha1(self.items[i].get("text", "").encode("utf-8", "replace")).hexdigest()[:16]
        self.router.meta.update(self.id, spoken=(notes + [{"key": key, "text": line}])[-200:])
        if say:
            self.router.emit("announce", session=self.id, text=line)

    def restore_spoken(self):
        """Voice bubbles from earlier, back under the messages they were about."""
        notes = self.router.meta.session(self.id).get("spoken") or []
        if not notes:
            return
        by_key = {}
        for it in self.items:
            if it.get("kind") == "assistant":
                by_key[hashlib.sha1(it.get("text", "").encode("utf-8", "replace")).hexdigest()[:16]] = it["i"]
        for n in notes:
            if n.get("key") in by_key:
                self.add({"kind": "spoken", "text": n["text"], "for": by_key[n["key"]]})

    def rewind_mark(self):
        """The pending rewind, if it still applies: once anything new hangs off the rewind point (a message sent
        since, from here or another window), the conversation has already moved on to the new branch."""
        mark = self.router.meta.session(self.id).get("rewind")
        if not mark:
            return None
        try:
            with open(self.router.session_file(self.id, self.cwd)[1], encoding="utf-8") as f:
                moved_on = any(e.get("parentUuid") == mark["at"] and e.get("uuid") != mark["drop"]
                               and not e.get("isSidechain") for e in map(json.loads, filter(str.strip, f)))
        except (OSError, ValueError):
            moved_on = False
        if moved_on:
            self.router.meta.update(self.id, rewind=None)
            return None
        return mark

    async def rewind_files_to(self, uuid):
        """Put the folder's files back the way they were when that message was sent (Claude Code's checkpoints)."""
        await self.connect()
        await self.client.rewind_files(uuid)

    async def learn_commands(self):
        """The slash commands Claude Code offers here (built-in, skills, the folder's and your custom commands), for
        the / list in the message box. Remembered per folder, so the list is there before a session connects."""
        try:
            info = await self.client.get_server_info() if self.client else None
        except Exception as e:
            log.debug("server info %s: %s", self.id, e)
            return
        cmds = [{"name": c.get("name"), "description": c.get("description") or "", "hint": c.get("argumentHint") or ""}
                for c in (info or {}).get("commands") or [] if isinstance(c, dict) and c.get("name")]
        if cmds:
            self.router.meta.data.setdefault("commands", {})[self.cwd or ""] = cmds
            self.router.meta.save()

    async def disconnect(self):
        client, self.client = self.client, None
        if self.reader:
            self.reader.cancel()
            self.reader = None
        if client:
            try:
                await client.disconnect()
            except Exception as e:
                log.debug("disconnect %s: %s", self.id, e)
        if self.items:
            self.resumed = True   # reconnecting must resume, not start over

    async def read_loop(self, client):
        """Everything Claude sends, for as long as the connection lives: replies to your messages, and replies it
        starts by itself (a background task finished), plus background-task progress in between."""
        try:
            async for m in client.receive_messages():
                try:
                    self.dispatch(m)
                except Exception:
                    log.exception("Couldn't handle a message from Claude")
        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.warning("Session %s stopped listening: %s", self.id, e)
        finally:
            if self.turn_future and not self.turn_future.done():
                self.turn_future.set_exception(RuntimeError("Claude stopped responding"))
            if self.client is client:   # Claude's process ended on its own
                self.client = None
                self.reader = None
                self.resumed = True

    def dispatch(self, m):
        if isinstance(m, (sdk.TaskStartedMessage, sdk.TaskProgressMessage, sdk.TaskUpdatedMessage,
                          sdk.TaskNotificationMessage)):
            return self.on_task(m)
        in_turn = self.turn_future is not None and not self.turn_future.done()
        if not in_turn and not self.unsolicited and isinstance(m, (sdk.AssistantMessage, sdk.StreamEvent)):
            self.unsolicited = True          # Claude picked up again by itself, e.g. a background task finished
            self.busy = True
            self.turn_started()
            self.router.set_work(self, "thinking")
        self.heard += 1
        result = self.handle(m)
        if isinstance(m, sdk.ResultMessage):
            # a message sent now came too late to join: Claude answers it next. Held for one more reply at most (an
            # echo that didn't match mustn't keep the turn open), and let go if Claude Code goes quiet instead.
            if in_turn and self.injected and not self.holding:
                self.holding = True
                self.stream_item = None
                heard = self.heard
                asyncio.get_running_loop().call_later(HOLD_QUIET_S, lambda: self.heard == heard and self.let_go())
            elif in_turn:
                self.turn_future.set_result(result)
            elif self.unsolicited:
                self.unsolicited = False
                self.busy = False
                self.after_turn()

    def after_turn(self):
        self.stream_item = None
        if not self.loading_history_flag():
            asyncio.ensure_future(self.announce(speak=not self.voice_turn))
            asyncio.ensure_future(self.suggest(self.turn_count))   # the count now: a queued message may start next
        self.voice_turn = False   # a later reply on its own (a background task finished) gets announced
        if self.think_item is not None:   # a thought that never got its closing block (stopped mid-way)
            self.think_item["streaming"] = False
            self.changed(self.think_item)
            self.think_item = None
        if self.router.meta.session(self.id).get("rewind"):
            self.router.meta.update(self.id, rewind=None)
        if self.client:
            asyncio.ensure_future(self.measure_context())
        if getattr(self, "reconnect_after", False) and not self.running_tasks():   # extra folders changed mid-reply
            self.reconnect_after = False
            asyncio.ensure_future(self.disconnect())
        if self.router.active is not self:   # finished while you were looking at another session
            self.router.meta.update(self.id, unseen=True)
        self.router.set_work(self, "background" if self.running_tasks() else "idle")
        self.router.sessions_changed(self.cwd)

    # --- background tasks ---
    def running_tasks(self):
        return [t for t in self.tasks.values() if t["status"] in ("pending", "running")]

    def on_task(self, m):
        t = self.tasks.get(m.task_id)
        if t is None:
            t = self.tasks[m.task_id] = {"kind": "task", "task_id": m.task_id, "status": "running",
                                         "description": "", "started": time.time(), "output_file": None}
            t["tool_use_id"] = getattr(m, "tool_use_id", None)
            t["output_file"] = self.task_outputs.get(t["tool_use_id"])
            tool = self.tool_item(t["tool_use_id"]) if t["tool_use_id"] else None
            t["command"] = ((tool or {}).get("input") or {}).get("command")
            self.add(t)
        if getattr(m, "description", None):
            t["description"] = m.description
        if isinstance(m, sdk.TaskStartedMessage):
            t["type"] = m.task_type
        elif isinstance(m, sdk.TaskProgressMessage):
            t["last_tool"] = m.last_tool_name
        elif isinstance(m, sdk.TaskUpdatedMessage) and m.status:
            t["status"] = m.status
        elif isinstance(m, sdk.TaskNotificationMessage):
            t["status"] = m.status or t["status"]
            t["summary"] = m.summary
            t["output_file"] = m.output_file or t["output_file"]
        if t["status"] in ("stopped", "killed") and isinstance(m, sdk.TaskNotificationMessage):
            self.correct_lost_task(t)
        if t["status"] not in ("pending", "running"):
            t["ended"] = t.get("ended") or time.time()
        self.changed(t)
        self.save_tasks()
        if not self.busy:
            self.router.set_work(self, "background" if self.running_tasks() else "idle")

    def correct_lost_task(self, t):
        """After a restart Claude Code reports its old background commands as stopped, but they keep running on their
        own. Say what really happened: finished (with its exit code), or still running."""
        code = exit_code(t.get("output_file"))
        earlier = self.router.finished_tasks.get(t["task_id"])
        if code is None and earlier:
            code = earlier.get("exit_code")
        if code is not None:
            t.update(finished_card(code))
        elif command_running(task_command(t), running_shells()) or \
                any(d.get("task_id") == t["task_id"] for d in self.router.detached.get(self.id, [])):
            t.update(status="running", detached=True, summary=None, ended=None)
            self.router.follow(self.id, t)
        else:
            t["summary"] = "Stopped: its process ended without finishing (Yo Claude or Claude Code restarted)."

    def save_tasks(self):
        """Running tasks, with this session's Claude process id: after a restart Yo Claude can follow them."""
        running = [{k: t.get(k) for k in ("task_id", "description", "output_file", "started", "type", "command")}
                   for t in self.running_tasks()]
        self.router.meta.update(self.id, tasks=running, tasks_pid=self.pid, cwd=self.cwd)

    async def turn(self, prompt, voice, item=None, text=None):
        """Send one message and stream the reply into the transcript. Returns Claude's final text. `item` is your
        message in the transcript: it's marked queued while an earlier reply runs, and skipped if you cancel it.
        `text` is the prompt's text when `prompt` isn't a plain string (with images): "send now" matches it."""
        if self.lock is None:
            self.lock = asyncio.Lock()
        if item is not None and (self.busy or self.lock.locked() or self.order):
            item["queued"] = True
            self.waiting[item["i"]] = (prompt, text if text is not None else prompt)
            self.changed(item)
            self.order.append(item["i"])
            self.save_pending()
            try:   # in line: it goes when it's first (you can reorder the line) and the reply before it is done
                while not (item.get("cancelled") or item.get("sent_now")
                           or (self.order[0] == item["i"] and not self.lock.locked())):
                    await asyncio.sleep(0.15)
            finally:
                self.order.remove(item["i"])
                self.save_pending()
        async with self.lock:
            if item is not None:   # (what it says now: Haiku may have fixed it while it waited, see Router.tidy_queued)
                prompt = self.waiting.pop(item["i"], (prompt,))[0]
            if item is not None and item.get("cancelled"):
                return None
            if item is not None and item.get("sent_now"):   # already answered in the reply it joined
                joined = self.joined.pop(item["i"], None)
                ok = joined and joined.done() and not joined.cancelled() and not joined.exception()
                if ok or item.get("taken") or not isinstance(prompt, str):
                    if item.pop("queued", None):   # never seen taken up (let go of): into the flow anyway
                        item["at"] = len(self.items)
                        self.changed(item)
                    return joined.result() if ok else None
                item["sent_now"] = False   # that reply failed before Claude took it up: send it as its own turn
            if item is not None and item.pop("queued", None):
                item["at"] = len(self.items)   # shown from here on, below what came while it waited
                self.changed(item)
            self.last_used = time.time()
            self.voice_turn = voice
            self.busy = True
            self.turn_started()
            self.router.set_work(self, "thinking")
            if item is not None:   # something to queue after it, guessed while Claude works
                asyncio.ensure_future(self.suggest_early(self.turn_count, item.get("text")))
            try:
                if self.cwd and not self.baseline:   # the changes panel needs "before" captured before any edit
                    await asyncio.to_thread(self.router.take_baseline, self, "opened" if self.resumed else "start")
                await self.connect()
                self.turn_future = asyncio.get_running_loop().create_future()
                await self.client.query(prompt)
                return await self.turn_future or ""
            except Exception as e:
                log.exception("Turn failed")
                if "Resume rejected" in str(e):   # a rewind that no longer fits: drop it, a retry carries on as usual
                    self.router.meta.update(self.id, rewind=None)
                self.add({"kind": "error", "text": f"{type(e).__name__}: {e}"})
                await self.disconnect()
                return None
            finally:
                self.turn_future = None
                self.injected, self.holding = [], False
                self.busy = False
                self.voice_turn = False
                self.after_turn()

    def let_go(self):
        """A reply held open for a sent-now message Claude hasn't taken up: stop waiting for it."""
        if self.holding and self.turn_future and not self.turn_future.done():
            self.injected, self.holding = [], False
            self.turn_future.set_result("")

    async def send_now(self, item):
        """Give Claude a queued message now, during the reply in progress, instead of after it. Claude Code takes it
        up at its next tool call (or answers it straight after, if the reply has no tool calls left); its turn() then
        just returns that reply. Returns an error message, or None."""
        if item.get("kind") != "user" or not item.get("queued") or item["i"] not in self.waiting:
            return "That message has already been sent."
        if not self.client or not self.turn_future or self.turn_future.done():
            if self.lock and self.lock.locked():   # the reply before it is still starting (connecting)
                return "Claude hasn't started that reply yet: try again in a moment, or it goes when it's done."
            return None   # between replies: it's about to go anyway
        prompt, text = self.waiting[item["i"]]
        if isinstance(text, str) and text.lstrip().startswith("/"):
            return "Commands can't join a reply in progress: they run when Claude is done."
        del self.waiting[item["i"]]
        # before the await: turn() mustn't send it too. It stays pinned at the bottom (marked sent) until Claude takes
        # it up: at its next tool call, or after this reply if it has none left
        item["sent_now"] = True
        self.injected.append((item, " ".join(str(text).split())))
        self.joined[item["i"]] = self.turn_future
        self.changed(item)
        try:
            await self.client.query(prompt)
        except Exception as e:   # not delivered: back in the queue
            log.warning("Couldn't send a queued message now: %s", e)
            self.injected = [x for x in self.injected if x[0] is not item]
            self.joined.pop(item["i"], None)
            self.waiting[item["i"]] = (prompt, text)
            item["sent_now"] = False
            self.changed(item)
            return f"Couldn't send it now: {e}"
        return None

    async def measure_context(self):
        """How full the context window is, by category (Claude Code's /context), for the meter and its breakdown."""
        client = self.client
        if not client:
            return
        try:
            u = await client.get_context_usage()
        except Exception as e:
            log.debug("context usage: %s", e)
            return
        top = lambda items, n: sorted(({"name": i.get("name") or i.get("path") or i.get("serverName") or "?",
                                        "tokens": i.get("tokens", 0), "server": i.get("serverName")}
                                       for i in (items or []) if isinstance(i, dict)),
                                      key=lambda i: -i["tokens"])[:n]
        self.context = {"total": u.get("totalTokens", 0), "max": u.get("maxTokens", 0),
                        "percentage": u.get("percentage", 0), "model": u.get("model"),
                        "autocompact": u.get("autoCompactThreshold") if u.get("isAutoCompactEnabled") else None,
                        "categories": [{"name": c["name"], "tokens": c["tokens"], "color": c.get("color"),
                                        "deferred": bool(c.get("isDeferred"))} for c in u.get("categories", [])],
                        "mcp": top(u.get("mcpTools"), 8), "memory": top(u.get("memoryFiles"), 6),
                        "breakdown": {k: v for k, v in (u.get("messageBreakdown") or {}).items() if isinstance(v, int)}}
        skills = u.get("skills") or {}
        self.context["skills"] = [{"name": k.get("name"), "tokens": k.get("tokens", 0), "source": k.get("source"),
                                   "plugin": k.get("pluginName"), "plugin_id": k.get("pluginId")}
                                  for k in skills.get("skillFrontmatter") or [] if isinstance(k, dict)]
        self.context["skills_tokens"] = skills.get("tokens", 0)
        self.context["commands_tokens"] = (u.get("slashCommands") or {}).get("tokens", 0)
        tool_tokens = {}
        for t in u.get("mcpTools") or []:
            if isinstance(t, dict):
                tool_tokens[t.get("serverName")] = tool_tokens.get(t.get("serverName"), 0) + t.get("tokens", 0)
        try:
            status = (await client.get_mcp_status() or {}).get("mcpServers") or []
        except Exception as e:
            log.debug("mcp status: %s", e)
            status = []
        self.context["servers"] = [{"name": m.get("name"), "status": m.get("status"), "error": m.get("error"),
                                    "tools": len(m.get("tools") or []), "source": m.get("source"),
                                    "tokens": tool_tokens.get(m.get("name"), 0)} for m in status if isinstance(m, dict)]
        off = self.router.settings
        self.context["off"] = {"mcp": off.get("off_mcp") or [], "skills": off.get("off_skills") or [],
                               "plugins": off.get("off_plugins") or []}
        self.router.emit("context", session=self.id, context=self.context)

    def handle(self, m):
        if isinstance(m, sdk.RateLimitEvent):
            self.router.on_rate_limit(m.rate_limit_info)
            return None
        if isinstance(m, sdk.StreamEvent):
            ev = m.event or {}
            if m.parent_tool_use_id:
                return None
            if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "thinking_delta":
                if self.think_item is None:
                    self.think_item = self.add({"kind": "thinking", "text": "", "streaming": True})
                self.think_item["text"] += ev["delta"].get("thinking", "")
                self.router.emit("delta", session=self.id, i=self.think_item["i"], text=ev["delta"].get("thinking", ""))
                return None
            if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                if self.stream_item is None:
                    self.stream_item = self.add({"kind": "assistant", "text": "", "streaming": True})
                self.stream_item["text"] += ev["delta"]["text"]
                self.router.emit("delta", session=self.id, i=self.stream_item["i"], text=ev["delta"]["text"])
            return None
        if isinstance(m, sdk.AssistantMessage):
            if m.parent_tool_use_id:
                return None
            for b in m.content:
                if isinstance(b, sdk.TextBlock):
                    text = self.advisor_said(b.text)
                    if self.stream_item is not None:   # (only the advisor's advice in it: gone from the chat)
                        self.stream_item.update(text=text, streaming=False, **({} if text.strip() else {"kind": "cancelled"}))
                        self.changed(self.stream_item)
                        self.stream_item = None
                    elif text.strip():
                        self.add({"kind": "assistant", "text": text})
                elif isinstance(b, sdk.ThinkingBlock):
                    if self.think_item is not None:   # the streamed thought, now complete
                        self.think_item.update(text=b.thinking or self.think_item["text"], streaming=False)
                        self.changed(self.think_item)
                        self.think_item = None
                    elif b.thinking:
                        self.add({"kind": "thinking", "text": b.thinking})
                elif isinstance(b, sdk.ToolUseBlock):
                    self.stream_item = None
                    self.add({"kind": "tool", "id": b.id, "name": b.name, "input": b.input, "result": None,
                              "status": "running"})
                    if b.name.startswith(f"mcp__{PC_CONTROL_SERVER}__"):
                        self.router.set_work(self, "using_pc")
                elif isinstance(b, sdk.ServerToolUseBlock) and b.name == "advisor":   # a third member of the chat
                    self.stream_item = None
                    self.add({"kind": "advisor", "id": b.id, "text": "", "status": "asking", "asked": time.time()})
                elif isinstance(b, sdk.ServerToolResultBlock):   # the advisor's reply (encrypted: Claude passes it on)
                    item = next((x for x in reversed(self.items)
                                 if x.get("kind") == "advisor" and x.get("id") == b.tool_use_id), None)
                    if item and item["status"] == "asking":
                        item.update(status="heard", took=round(time.time() - item.get("asked", time.time()), 1))
                        self.changed(item)
            return None
        if isinstance(m, sdk.UserMessage):
            if getattr(m, "uuid", None) and not m.parent_tool_use_id and not (
                    isinstance(m.content, list) and any(isinstance(b, sdk.ToolResultBlock) for b in m.content)):
                said = m.content if isinstance(m.content, str) else \
                    next((b.text for b in m.content if isinstance(b, sdk.TextBlock)), "")
                said = " ".join(said.split())[:200]
                sent = next((x for x in self.injected if x[1][:200] == said), None)
                if sent:   # a message sent now: Claude has taken it up
                    self.injected.remove(sent)
                    sent[0].update(taken=True, queued=False, at=len(self.items))   # into the flow, here
                    # its own turn (after the reply it was sent into) is a real message you can rewind to; folded
                    # into that reply it's only a note on a tool result in the session file, with no id to go back to
                    own_turn, self.holding = self.holding, False
                    if own_turn and not sent[0].get("uuid"):
                        sent[0]["uuid"] = m.uuid
                    self.changed(sent[0])
                    return None
                for item in reversed(self.items):   # your prompt, echoed back with its message id
                    if item["kind"] == "user" and not item.get("queued") and \
                            not any(x[0] is item for x in self.injected):
                        if not item.get("uuid"):
                            item["uuid"] = m.uuid
                            self.changed(item)
                        break
                return None
            if isinstance(m.content, list):
                for b in m.content:
                    if isinstance(b, sdk.ToolResultBlock):
                        item = self.tool_item(b.tool_use_id)
                        if item:
                            item["result"] = result_text(b.content)
                            item["status"] = "error" if b.is_error else "done"
                            pics = result_images(b.content)
                            if pics:   # what Claude saw (screenshots), as a small thumbnail
                                item["image"] = thumbnail(pics[-1][1])
                            self.changed(item)
                            out = re.search(r"Output is being written to: (.+?\.output)", item["result"] or "")
                            if out:   # a background task: where its output goes (kept for after a restart)
                                self.task_outputs[b.tool_use_id] = out.group(1)
                                for t in self.tasks.values():
                                    if t.get("tool_use_id") == b.tool_use_id:
                                        t["output_file"] = out.group(1)
                                        self.changed(t)
                                        self.save_tasks()
                            path = (item["input"] or {}).get("file_path")
                            if path and item["name"] in ("Edit", "MultiEdit", "Write", "NotebookEdit") \
                                    and path not in self.touched:
                                self.touched.append(path)
                            self.router.emit("tool_done", session=self.id, name=item["name"])
                if self.router.work_state(self) == "using_pc":
                    self.router.set_work(self, "thinking")
            return None
        if isinstance(m, sdk.ResultMessage):
            self.resumed = True
            self.router.meta.update(self.id, source="yoclaude", cwd=self.cwd)
            u = m.usage or {}
            tokens = sum(u.get(k, 0) or 0 for k in ("input_tokens", "cache_creation_input_tokens",
                                                     "cache_read_input_tokens"))
            total = m.total_cost_usd or 0.0   # the session's running total: this reply's share is the difference
            known = self.cost_seen is not None and total >= self.cost_seen
            cost = total - self.cost_seen if known else None   # unknown: show the tokens without a wrong price
            self.cost_seen = total
            self.router.meta.update(self.id, cost_total=total)
            self.add({"kind": "result", "cost": cost, "tokens": tokens,
                      "cached": u.get("cache_read_input_tokens", 0), "duration": m.duration_ms,
                      "error": m.is_error})
            log.info("Turn done in %.1fs: %d tokens processed (%d cached), %s api-equivalent",
                     (m.duration_ms or 0) / 1000, tokens, u.get("cache_read_input_tokens", 0) or 0,
                     f"${cost:.4f}" if cost is not None else "cost unknown")
            return ADVISOR_BLOCK.sub("", m.result or "").strip()
        return None


# --- the router -------------------------------------------------------------------------------------------------
def iso_time(text):
    """Claude Code's ISO timestamps ("2026-10-30T09:12:44.123Z") as seconds since the epoch, or None."""
    try:
        return datetime.datetime.fromisoformat(str(text).replace("Z", "+00:00")).timestamp()
    except (TypeError, ValueError):
        return None


def message_times(path):
    """When each message of a session was written: message id -> seconds since the epoch."""
    out = {}
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                if '"timestamp"' not in raw:
                    continue
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                if d.get("uuid") and d.get("timestamp"):
                    out[d["uuid"]] = iso_time(d["timestamp"])
    except OSError:
        pass
    return out


def folded_prompts(path):
    """Messages you sent while Claude was working that it took in mid-reply: Claude Code files them as attachments
    to the message before (not as messages of their own; several in a row hang off each other, and other attachments
    can sit in between). That message's id -> [(attachment id, your text)], in the order sent."""
    parents, found, out = {}, [], {}
    try:
        with open(path, encoding="utf-8") as f:
            for raw in f:
                if '"attachment"' not in raw:
                    continue
                try:
                    d = json.loads(raw)
                except ValueError:
                    continue
                if d.get("type") != "attachment":
                    continue
                parents[d.get("uuid")] = d.get("parentUuid")
                a = d.get("attachment") or {}
                if a.get("type") == "queued_command" and a.get("commandMode", "prompt") == "prompt":
                    text = a.get("prompt")
                    if isinstance(text, list):   # with images: just its text
                        text = "\n".join(b.get("text", "") for b in text if isinstance(b, dict) and b.get("type") == "text")
                    if isinstance(text, str) and text.strip() and not text.lstrip().startswith("<") \
                            and not is_noise(text):   # not agent messages or Claude Code bookkeeping
                        found.append((d.get("uuid"), d.get("parentUuid"), text))
    except OSError:
        pass
    for uid, parent, text in found:
        for _ in range(100):   # up past attachments, to the message they hang off
            if parent not in parents:
                break
            parent = parents[parent]
        out.setdefault(parent, []).append((uid, text))
    return out


def agent_items(path, limit=400):
    """A subagent's transcript as items to show: its brief ("user"), what it said ("assistant", Markdown), each
    tool it used ("tool": name, a one-line brief, whether it failed) and its report back ("report")."""
    items, tools = [], {}

    def brief(inp):
        inp = inp or {}
        for k in ("description", "command", "file_path", "pattern", "url", "query", "prompt"):
            if inp.get(k):
                return " ".join(str(inp[k]).split())[:200]
        return ""
    with open(path, encoding="utf-8") as f:
        for raw in f:
            try:
                d = json.loads(raw)
            except ValueError:
                continue
            content = (d.get("message") or {}).get("content")
            ts = iso_time(d.get("timestamp"))
            if d.get("type") == "user" and isinstance(content, str):
                items.append({"kind": "user", "text": content.strip(), "ts": ts})
            elif d.get("type") == "user" and isinstance(content, list):
                for b in content:   # results: mark the tools that failed
                    if isinstance(b, dict) and b.get("type") == "tool_result" and b.get("is_error"):
                        if b.get("tool_use_id") in tools:
                            tools[b["tool_use_id"]]["error"] = True
            elif d.get("type") == "assistant" and isinstance(content, list):
                for b in content:
                    if b.get("type") == "text" and b.get("text", "").strip():
                        items.append({"kind": "assistant", "text": b["text"].strip(), "ts": ts})
                    elif b.get("type") == "tool_use" and b.get("name") == "SubagentHandback":
                        items.append({"kind": "report", "text": str((b.get("input") or {}).get("message", "")), "ts": ts})
                    elif b.get("type") == "tool_use":
                        item = tools[b.get("id")] = {"kind": "tool", "name": b.get("name"), "brief": brief(b.get("input")),
                                                     "ts": ts}
                        items.append(item)
    return items[-limit:]


def agent_steps(path, limit=400):
    """The same as plain text (for copying)."""
    try:
        items = agent_items(path, limit)
    except OSError as e:
        return f"Couldn't read its transcript: {e}"
    return "\n".join({"user": lambda i: "> " + i["text"], "assistant": lambda i: i["text"],
                      "report": lambda i: "✓ reported back:\n" + i["text"],
                      "tool": lambda i: f"⚙ {i['name']}  {i['brief']}".rstrip() + ("  (failed)" if i.get("error") else "")}
                     [i["kind"]](i) for i in items)


class Router:
    """Owns the sessions. Thread-safe entry points; everything SDK runs on its own event loop."""

    def __init__(self, settings, emit):
        self.settings = settings
        self._emit = emit
        self.meta = Meta()
        self.live = {}                      # session id -> Session (open in the app this run)
        self.active = None                  # the session voice and the input box talk to
        self.folder = None                  # folder new sessions use; None = chat
        self.work = {}                      # session id -> "thinking" | "using_pc" | "awaiting_approval" | "background"
        self.detached = {}                  # session id -> background tasks still running from before a restart
        self.finished_tasks = {}            # task id -> how a task from before a restart ended
        self.btw = {}                       # session id -> its open /btw side chat {"id", "queue", "future"}
        self.watcher = None
        self.limits = self.meta.data.get("limits")   # last known plan usage limits
        self.on_voice_approval = None       # set by the voice assistant
        os.makedirs(CHAT_DIR, exist_ok=True)
        os.makedirs(TRASH_DIR, exist_ok=True)
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, name="sessions", daemon=True).start()
        self.restore_detached()

    def emit(self, kind, **data):
        self._emit(kind, data)

    def run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self.loop)

    # --- state for the icons ---
    def set_work(self, session, state):
        sid = session if isinstance(session, str) else session.id
        if state == "idle":
            self.work.pop(sid, None)
        else:
            self.work[sid] = state
        self.emit("work", state=self.work_summary(), session=sid, session_state=state)

    def work_state(self, session):
        return self.work.get(session.id, "idle")

    def work_summary(self):
        states = set(self.work.values())
        for s in ("awaiting_approval", "using_pc", "thinking", "background"):
            if s in states:
                return s
        return "idle"

    def on_rate_limit(self, info):
        """Plan usage limits (5-hour and weekly windows), as Claude Code reports them with each reply."""
        raw = info.raw or {}
        windows = {k: {"utilization": v.get("utilization"), "resets_at": v.get("resetsAt")}
                   for k, v in (raw.get("unifiedWindows") or {}).items() if isinstance(v, dict)}
        if not windows and info.rate_limit_type:
            windows[info.rate_limit_type] = {"utilization": info.utilization, "resets_at": info.resets_at}
        self.limits = {"windows": windows, "status": info.status, "type": info.rate_limit_type,
                       "overage": info.overage_status, "overage_reason": info.overage_disabled_reason,
                       "using_overage": raw.get("isUsingOverage"), "updated": time.time()}
        self.meta.data["limits"] = self.limits
        self.meta.save()
        self.emit("limits", limits=self.limits)

    def busy_report(self):
        """What would be lost by quitting now: sessions mid-reply, and background tasks (those survive a restart)."""
        out = []
        for sid, state in self.work.items():
            s = self.live.get(sid)
            title = self.title_of(sid)
            tasks = [t["description"] for t in s.running_tasks()] if s else \
                    [t.get("description") for t in self.detached.get(sid, [])]
            out.append({"id": sid, "title": title, "state": state, "tasks": tasks})
        return out

    def shutdown(self):
        """Quitting: close sessions, except ones with background tasks running. Those keep going on their own and
        Yo Claude picks them up again at its next start (restore_detached)."""
        for sid in list(self.btw):
            self.btw_close(sid)
        for s in list(self.live.values()):
            if s.running_tasks():
                s.save_tasks()
                log.info("Leaving %s running: %d background task(s)", s.id, len(s.running_tasks()))
                continue
            try:
                self.run(s.disconnect()).result(5)
            except Exception:
                pass

    # --- background tasks that outlived a restart ---
    def restore_detached(self):
        """Background tasks still recorded from before Yo Claude last quit (or was killed)."""
        for sid, m in list(self.meta.data["sessions"].items()):
            if m.get("tasks") and not m.get("deleted"):
                self.detached[sid] = m["tasks"]
                self.work[sid] = "background"
                log.info("Following %d background task(s) of %s from before the restart", len(m["tasks"]), sid)
        if self.detached:
            self.watcher = threading.Thread(target=self.watch_detached, daemon=True, name="detached-tasks")
            self.watcher.start()

    def detached_alive(self, sid):
        """Finished when every task's output ends with Claude Code's "[exited with code N]" marker. Tasks without one
        (agents) count as running while their Claude process lives or their output changed in the last minute."""
        m = self.meta.session(sid)
        unknown = False
        shells = running_shells()
        for t in self.detached.get(sid, []):
            out = t.get("output_file")
            if t.get("ended"):
                continue
            if command_running(task_command(t), shells):
                return True
            if out and os.path.exists(out) and time.time() - os.path.getmtime(out) < 60:
                return True
            if task_command(t) and shells is not None:   # we know what to look for, and it's gone
                continue
            unknown = True
        return unknown and pid_alive(m.get("tasks_pid"))

    def follow(self, sid, t):
        """Keep watching a background command Claude Code lost track of (its process is still running)."""
        tasks = self.detached.setdefault(sid, [])
        if not any(d.get("task_id") == t.get("task_id") for d in tasks):
            tasks.append({k: t.get(k) for k in ("task_id", "description", "output_file", "started", "type", "command")})
            self.work[sid] = "background"
            log.info("Following background task %s of %s: its process is still running", t.get("task_id"), sid)
        if not self.watcher or not self.watcher.is_alive():
            self.watcher = threading.Thread(target=self.watch_detached, daemon=True, name="detached-tasks")
            self.watcher.start()

    def watch_detached(self):
        import pythoncom
        pythoncom.CoInitialize()   # running_shells() asks Windows (WMI) from this thread
        while self.detached:
            for sid in list(self.detached):
                shells = running_shells()
                for t in self.detached.get(sid, []):
                    if t.get("ended"):
                        continue
                    code = exit_code(t.get("output_file"))
                    gone = code is None and task_command(t) and shells is not None \
                        and not command_running(task_command(t), shells)
                    if code is not None or gone:   # this one's done: its card says so now, not when they all are
                        t["ended"], t["exit_code"] = time.time(), code
                        self.detached_card(sid, t)
                if not self.detached_alive(sid):
                    self.detached_finished(sid)
            time.sleep(5)

    def detached_card(self, sid, t):
        """Bring a restored task's card in the transcript up to date with how it ended."""
        s = self.live.get(sid)
        item = s.tasks.get(t.get("task_id")) if s else None
        if item is not None:
            item.update(finished_card(t.get("exit_code")), ended=t.get("ended") or time.time(), detached=False)
            s.changed(item)

    def detached_finished(self, sid):
        """A task from before the restart is done: let its session know, so Claude checks it and reports back."""
        tasks = self.detached.pop(sid, [])
        m = self.meta.session(sid)
        cwd = m.get("cwd")
        self.meta.update(sid, tasks=[], tasks_pid=None)
        self.work.pop(sid, None)
        for t in tasks:
            if not t.get("ended"):
                t["ended"], t["exit_code"] = time.time(), exit_code(t.get("output_file"))
            self.finished_tasks[t.get("task_id")] = t
            self.detached_card(sid, t)
        def how(t):   # name it (its command when it has no description), and say how it ended
            code = t.get("exit_code")
            ended = "ran to the end (exit code 0)" if code == 0 else f"failed (exit code {code})" if code is not None \
                else "stopped (its process ended; how isn't known)"
            name = t.get("description") or task_command(t) or t.get("task_id") or "a background task"
            return f"\"{name}\" {ended}" + (f", output: {t['output_file']}" if t.get("output_file") else "")
        names = "; ".join(how(t) for t in tasks)
        log.info("Background task(s) of %s ended after the restart: %s", sid, names)
        s = self.live.get(sid)
        if s is None:
            s = Session(self, cwd, sid, resumed=True)
            s.load_history()
            self.live[sid] = s
        s.add({"kind": "note", "text": f"Background task ended while Yo Claude was restarting: {names}"})
        self.send(f"Yo Claude restarted while {'these background tasks' if len(tasks) > 1 else 'this background task'} "
                  f"kept running, so Claude Code's notice didn't reach you. Now: {names}. Check the result and carry on "
                  "with what you said you'd do when it was done (if you already knew, just say so briefly).",
                  sid=sid, origin="system")

    # --- the tasks panel: background commands and subagents, across sessions ---
    def rewind(self, sid, uuid, mode, export):
        """Undo from one of your messages onwards. mode: "both" (conversation and files), "conversation" (keep the
        files as they are) or "files" (keep the conversation). export: first copy the whole conversation to a new
        session, so the work being rewound isn't lost (it can carry on there without redoing anything)."""
        s = self.live.get(sid)
        if not s:
            return {"error": "Open the session first."}
        if s.busy:
            return {"error": "Claude is still working in this session. Wait until it finishes (or stop it), then rewind."}
        if s.running_tasks():
            return {"error": "This session has background tasks running. Wait for them, or stop them in the tasks tab."}
        try:
            messages = sdk.get_session_messages(sid, directory=s.cwd or CHAT_DIR)
        except Exception as e:
            return {"error": f"Couldn't read the conversation: {e}"}
        at = next((i for i, m in enumerate(messages) if m.uuid == uuid), None)
        if at is None:
            return {"error": "Couldn't find that message in the conversation. Reopen the session and try again."}
        if mode in ("both", "conversation") and at == 0:
            return {"error": "That's the first message, so nothing would be left: start a new session instead."}
        if mode in ("both", "files") and not s.cwd:
            return {"error": "Chats have no files to rewind: choose \"conversation only\"."}
        out = {}
        if export:
            try:
                f = sdk.fork_session(sid, directory=s.cwd or CHAT_DIR, title=f"{self.title_of(sid)} (rewound part)")
            except Exception as e:
                return {"error": f"Couldn't copy the conversation, so nothing was rewound: {e}"}
            out["export"] = f.session_id
            self.meta.update(f.session_id, title=f"{self.title_of(sid)} (rewound part)", cwd=s.cwd)
        if mode in ("both", "files"):
            try:
                self.run(s.rewind_files_to(uuid)).result(120)
            except Exception as e:
                log.warning("rewind files of %s: %s", sid, e)
                return dict(out, error=f"Couldn't put the files back: {e}. The conversation wasn't rewound.")
        if mode in ("both", "conversation"):
            prompt = messages[at].message if isinstance(messages[at].message, dict) else {}
            content = prompt.get("content")
            text = content if isinstance(content, str) else "\n".join(
                b.get("text", "") for b in content or [] if isinstance(b, dict) and b.get("type") == "text")
            out["text"] = re.sub(r'\s*<attached_file path="[^"]+">.*?</attached_file>', "", text, flags=re.S).strip()
            self.run(s.disconnect()).result(15)
            keep = next(m for m in reversed(messages[:at]) if not m.parent_tool_use_id)   # the last message kept
            self.meta.update(sid, rewind={"at": keep.uuid, "drop": uuid})
            s.items, s.tasks = [], {}
            s.load_history()
            self.open(sid, s.cwd)   # shows the shortened conversation
        self.sessions_changed(s.cwd)
        log.info("Rewound %s to before %s (%s)%s", sid, uuid, mode, f", copied to {out['export']}" if export else "")
        return out

    def title_of(self, sid):
        s = self.live.get(sid)
        return (self.meta.session(sid).get("title") or (s.items[0].get("text", "")[:60] if s and s.items else "")
                or sid[:8])

    def tasks_list(self):
        """Background commands and subagents of the sessions Yo Claude has open or is following, newest first."""
        out, cutoff = [], time.time() - TASKS_KEEP_S
        sids = {sid: (s.cwd if s else None) for sid, s in self.live.items()}
        for sid in self.detached:
            sids.setdefault(sid, self.meta.session(sid).get("cwd"))
        for sid, cwd in sids.items():
            s, base = self.live.get(sid), {"session": sid, "title": self.title_of(sid), "cwd": cwd}
            agents = self.subagents(sid, cwd)
            agent_tools = {a["tool_use_id"] for a in agents}
            shells = list(s.tasks.values()) if s else []
            shells += [dict(t, detached=True, **(finished_card(t.get("exit_code")) if t.get("ended") else {"status": "running"}))
                       for t in self.detached.get(sid, []) if t.get("task_id") not in (s.tasks if s else {})]
            for t in shells:
                if t.get("tool_use_id") in agent_tools or (t.get("ended") or time.time()) < cutoff:
                    continue
                out.append({**base, "key": f"{sid}:{t['task_id']}", "kind": "shell", "task_id": t["task_id"],
                            "description": t.get("description") or "background command", "status": t["status"],
                            "started": t.get("started"), "ended": t.get("ended"), "summary": t.get("summary"),
                            "detached": bool(t.get("detached")), "output_file": t.get("output_file")})
            ids = {t.get("tool_use_id"): t["task_id"] for t in shells if t.get("tool_use_id")}
            for a in agents:
                a["task_id"] = ids.get(a["tool_use_id"])   # background agents can be stopped like commands
                item = s.tool_item(a["tool_use_id"]) if s else None
                if item and item.get("status") == "running":
                    a["status"], a["ended"] = "running", None
                if (a.get("ended") or time.time()) >= cutoff:
                    out.append({**base, **a, "key": f"{sid}:{a['agent_id']}", "kind": "agent"})
        return sorted(out, key=lambda t: (t["status"] != "running", -(t.get("started") or 0)))[:TASKS_SHOWN]

    def subagents(self, sid, cwd):
        """Claude Code keeps each subagent's transcript next to its session: <session>/subagents/agent-*.jsonl."""
        folder = os.path.join(self.session_file(sid, cwd)[0], sid, "subagents")
        out = []
        try:
            names = [n for n in os.listdir(folder) if n.endswith(".meta.json")]
        except OSError:
            return out
        for n in names:
            agent_id = n[len("agent-"):-len(".meta.json")]
            log_file = os.path.join(folder, f"agent-{agent_id}.jsonl")
            try:
                with open(os.path.join(folder, n), encoding="utf-8") as f:
                    m = json.load(f)
                st = os.stat(log_file)
            except (OSError, ValueError):
                continue
            recent = time.time() - st.st_mtime < AGENT_QUIET_S
            running = recent and not m.get("finished")
            out.append({"agent_id": agent_id, "tool_use_id": m.get("toolUseId"), "agent_type": m.get("agentType"),
                        "description": m.get("description") or m.get("agentType") or "subagent",
                        "background": m.get("requestShape") == "background", "agent_file": log_file,
                        "status": "done" if m.get("finished") else "running" if recent else "stopped",
                        "started": st.st_ctime, "ended": None if running else st.st_mtime})
        return out

    def task_output(self, key):
        """The tail of a background command's output, or a subagent's steps so far, as text."""
        t = next((t for t in self.tasks_list() if t["key"] == key), None)
        if not t:
            return {"error": "That task is no longer listed."}
        if t["kind"] == "shell":
            path = t.get("output_file")
            if not path or not os.path.exists(path):
                return {"text": "", "note": "No output yet." if path else "Its output file isn't known."}
            size = os.path.getsize(path)
            with open(path, "rb") as f:
                f.seek(max(0, size - TASK_TAIL_BYTES))
                text = f.read().decode("utf-8", "replace")
            return {"text": text, "cut": size > TASK_TAIL_BYTES, "path": path}
        try:
            items = agent_items(t["agent_file"])
        except OSError as e:
            return {"error": f"Couldn't read its transcript: {e}"}
        return {"items": items, "text": agent_steps(t["agent_file"]), "path": t["agent_file"]}

    def stop_task(self, sid, task_id):
        s = self.live.get(sid)
        if s and s.client and task_id in s.tasks:
            self.run(s.client.stop_task(task_id))
            return None
        return "That task isn't connected to this window (it started before Yo Claude restarted)."

    def evict(self, keep):
        """Keep at most MAX_LIVE sessions connected (never one whose background tasks are still running)."""
        connected = sorted((s for s in self.live.values()
                            if s.client and s is not keep and not s.busy and not s.running_tasks()),
                           key=lambda s: s.last_used)
        while len(connected) >= MAX_LIVE:
            asyncio.ensure_future(connected.pop(0).disconnect())

    # --- MCP servers ---
    def loadout_settings(self):
        """Claude Code settings for Yo Claude's sessions: no hooks, and the skills and plugins you turned off."""
        out = {"disableAllHooks": True}
        skills = self.settings.get("off_skills") or []
        plugins = self.settings.get("off_plugins") or []
        if skills:
            out["skillOverrides"] = {name: "off" for name in skills}
        if plugins:
            out["enabledPlugins"] = {pid: False for pid in plugins}
        return out

    def set_loadout(self, kind, name, on):
        """Turn an MCP server, skill or plugin on or off for Yo Claude's sessions. MCP servers switch at once in
        connected sessions; the rest apply from each session's next message (they're start-up options)."""
        key = {"mcp": "off_mcp", "skill": "off_skills", "plugin": "off_plugins"}[kind]
        off = [n for n in (self.settings.get(key) or []) if n != name] + ([] if on else [name])
        self.settings[key] = off
        self.settings.save()
        if kind == "mcp" and not on:
            for sess in self.live.values():
                if sess.client:
                    self.run(self.toggle_mcp(sess, name, False))
        else:
            self.reconnect_all()
        return None

    async def toggle_mcp(self, sess, name, on):
        try:
            await sess.client.toggle_mcp_server(name, on)
        except Exception as e:
            log.debug("toggle %s on %s: %s", name, sess.id, e)
        if sess is self.active:
            await sess.measure_context()

    def mcp_servers(self, cwd):
        """Your user MCP servers (+ the folder's .mcp.json) for code sessions; screen-control only with PC control."""
        servers = {}
        try:
            with open(os.path.expanduser("~/.claude.json"), encoding="utf-8") as f:
                config = json.load(f)
        except (OSError, ValueError):
            config = {}
        user = config.get("mcpServers", {})
        if cwd:
            servers.update(user)
            try:
                with open(os.path.join(cwd, ".mcp.json"), encoding="utf-8") as f:
                    servers.update(json.load(f).get("mcpServers", {}))
            except (OSError, ValueError):
                pass
        for name in self.settings.get("off_mcp") or []:   # turned off in the context window view
            servers.pop(name, None)
        servers.pop(PC_CONTROL_SERVER, None)
        if self.settings.get("pc_control"):
            server = pc_control_server() or user.get(PC_CONTROL_SERVER)
            if server:
                servers[PC_CONTROL_SERVER] = server
            else:
                log.warning("PC control is on but its server isn't installed (run install.ps1)")
        return servers

    # --- sessions list ---
    def list(self, cwd):
        """Sessions for a folder (None = chats), newest first, merged with our metadata."""
        try:
            infos = sdk.list_sessions(directory=cwd or CHAT_DIR)
        except Exception as e:
            log.warning("list_sessions failed: %s", e)
            infos = []
        meta = self.meta.data["sessions"]
        out, seen = [], set()
        for s in infos:
            m = meta.get(s.session_id, {})
            seen.add(s.session_id)
            out.append({"id": s.session_id, "title": m.get("title") or s.custom_title or s.summary or s.first_prompt
                        or "(empty)", "first": s.first_prompt, "modified": s.last_modified, "created": s.created_at,
                        "background": s.session_id in self.detached or bool(
                            s.session_id in self.live and self.live[s.session_id].running_tasks()),
                        "branch": s.git_branch, "cwd": cwd, "tag": s.tag, "source": m.get("source", "claude code"),
                        "pinned": bool(m.get("pinned")), "group": m.get("group"), "unseen": bool(m.get("unseen")),
                        "live": s.session_id in self.live, "busy": s.session_id in self.work})
        for s in self.live.values():   # brand-new sessions not written to disk yet
            if s.id not in seen and same_folder(s.cwd, cwd):
                out.append({"id": s.id, "title": "New session", "modified": s.last_used * 1000,
                            "created": s.last_used * 1000, "cwd": cwd, "source": "yoclaude", "pinned": False,
                            "group": None, "live": True, "busy": s.id in self.work})
        out.sort(key=lambda x: x["modified"] or 0, reverse=True)
        return out

    def sessions_changed(self, cwd):
        self.emit("sessions", cwd=cwd, sessions=self.list(cwd))

    # --- opening / creating ---
    def set_folder(self, folder):
        """The folder voice's "new session" uses (follows the session you're in)."""
        self.folder = folder or None
        if folder:
            self.meta.add_folder(folder)

    def workspaces(self):
        return [f for f in self.meta.data["workspaces"] if os.path.isdir(f)]

    def set_workspace(self, folder, present):
        """Add or remove a folder in the sidebar tree (its files and sessions are never touched)."""
        self.meta.set_workspace(folder, present)
        self.emit("workspaces", workspaces=self.workspaces())

    def new_session(self, cwd="current", picked=False):
        cwd = self.folder if cwd == "current" else cwd
        if cwd:
            self.meta.add_folder(cwd)
            if not any(same_folder(cwd, w) for w in self.meta.data["workspaces"]):
                self.set_workspace(cwd, True)
        s = Session(self, cwd)
        s.picked = picked
        self.live[s.id] = s
        self.active = s
        self.folder = cwd
        self.ensure_baseline(s, "start")
        self.emit("opened", session=self.describe(s), items=[])
        self.sessions_changed(cwd)
        return s

    def open(self, sid, cwd):
        s = self.live.get(sid)
        if s is None:
            s = Session(self, cwd, sid, resumed=True)
            s.load_history()
            for t in self.detached.get(sid, []):   # from before a restart: still running, or finished since
                item = {"kind": "task", "status": "running", "detached": True, **t}
                if t.get("ended"):
                    item.update(finished_card(t.get("exit_code")), detached=False)
                s.tasks[t["task_id"]] = item
                s.add(item)
            self.live[sid] = s
            pending = self.meta.session(sid).get("pending") or []
            if pending:   # queued when Yo Claude last closed: in the line again, in the same order
                self.meta.update(sid, pending=[])
                for p in pending:
                    files = p.get("attachments") or []
                    context = "\n\n".join(workspace.attachment_text(s.cwd, f) for f in files) if s.cwd else ""
                    self.send(p.get("text", ""), sid=sid, context=context, attachments=files)
        s.picked = True
        self.active = s
        self.folder = s.cwd
        self.remember_last(s)
        if self.meta.session(sid).get("unseen"):
            self.meta.update(sid, unseen=False)
            self.sessions_changed(cwd)
        self.ensure_baseline(s, "opened")
        self.emit("opened", session=self.describe(s), items=s.items)
        return s

    def remember_last(self, s):
        """The conversation you were last in (opened or talked to), to come back to at the next start."""
        self.meta.data["last_session"] = {"id": s.id, "cwd": s.cwd, "at": time.time()}
        self.meta.save()

    def reopen_last(self):
        """At start-up: back to the conversation you were last in, if that was within REOPEN_RECENT_S; after
        longer than that you start in a fresh chat."""
        last = self.meta.data.get("last_session")
        if self.active or not last or time.time() - last.get("at", 0) > REOPEN_RECENT_S:
            return None
        if self.meta.session(last["id"]).get("deleted") or not os.path.exists(self.session_file(last["id"], last.get("cwd"))[1]):
            return None
        try:
            return self.open(last["id"], last.get("cwd"))
        except Exception as e:
            log.warning("Couldn't reopen %s: %s", last["id"], e)
            return None

    def ensure_baseline(self, s, kind):
        """Snapshot the folder (in the background: git can take a moment on big repos)."""
        if not s.cwd or s.baseline:
            return
        saved = self.meta.session(s.id).get("baseline")
        if saved:
            s.baseline, s.baseline_kind = saved, self.meta.session(s.id).get("baseline_kind", "opened")
            return
        threading.Thread(target=self.take_baseline, args=(s, kind), daemon=True).start()

    def take_baseline(self, s, kind):
        if s.baseline or not s.cwd:
            return
        try:
            snap = workspace.snapshot(s.cwd)
        except Exception as e:
            log.warning("Snapshot of %s failed: %s", s.cwd, e)
            return
        if snap and not s.baseline:
            s.baseline, s.baseline_kind = snap, kind
            self.meta.update(s.id, baseline=snap, baseline_kind=kind, cwd=s.cwd)
            self.emit("baseline", session=s.id)

    def describe(self, s):
        return {"id": s.id, "cwd": s.cwd, "mode": s.mode, "permission_mode": s.permission_mode, "busy": s.busy,
                "model": s.model or "", "effort": s.effort or "", "extra_dirs": list(s.extra_dirs),
                "context": s.context}

    def set_extra_dirs(self, sid, dirs):
        """Folders a session may also read and write. Takes effect from its next message (a start-up option)."""
        s = self.live.get(sid)
        if not s:
            return "Open the session first."
        s.extra_dirs = [d for d in dict.fromkeys(dirs) if os.path.isdir(d) and not same_folder(d, s.cwd)]
        self.meta.update(sid, extra_dirs=s.extra_dirs)
        if s.client and not s.busy:
            self.run(s.disconnect())
        elif s.client:
            s.reconnect_after = True
        self.emit("session_info", session=self.describe(s))
        return None

    # --- talking ---
    def send(self, text, voice=False, sid=None, context="", attachments=(), images=(), origin="user", queued_by=None):
        """Send a message to a session (default: the active one). Returns a concurrent Future with the reply.
        `context` is extra prompt text (attached files); `images` are (media_type, base64) pairs. origin="system" is
        Yo Claude itself writing (shown as a note, not as you)."""
        s = self.live.get(sid) if sid else self.active
        if s is None:
            s = self.new_session()
        item = None
        if origin == "user":
            self.remember_last(s)
            item = s.add({"kind": "user", "text": text, "voice": voice, "attachments": list(attachments),
                          **({"queued_by": queued_by} if queued_by else {}),
                          "image_paths": [save_image(s.id, mt, data) for mt, data in images],
                          **({"queued": True} if s.busy or (s.lock and s.lock.locked()) or s.order else {})})
        prompt = (f"[voice] {text}" if voice else text) + (f"\n\n{context}" if context else "")
        if origin == "system":
            prompt = f"[Yo Claude] {text}"
        said = prompt
        if images:
            content = [{"type": "text", "text": prompt}] + [
                {"type": "image", "source": {"type": "base64", "media_type": mt, "data": data}} for mt, data in images]

            async def message():
                yield {"type": "user", "message": {"role": "user", "content": content}, "parent_tool_use_id": None,
                       "session_id": s.id}
            prompt = message()
        if item is not None and item.get("queued") and isinstance(prompt, str) and origin == "user" and not voice:
            self.run(self.tidy_queued(s, item, text))
        return self.run(s.turn(prompt, voice, item, said))

    async def tidy_queued(self, s, item, text):
        """A typed message that's waiting its turn: Haiku fixes its spelling and grammar meanwhile (AutoCorrect), and
        the fixed text is what goes (the bubble shows it). Left alone if it's sent, sent now or cancelled first."""
        if not self.settings.get("fix_text", True) or text.lstrip().startswith("/"):
            return
        await asyncio.sleep(0)   # (after turn() has put it in the queue)
        try:
            context = next((x.get("text", "") for x in reversed(s.items) if x.get("kind") == "assistant"), "")
            fixed = await tidy_text(text, context)
        except Exception as e:
            log.info("Couldn't fix a queued message: %s", e)
            return
        w = s.waiting.get(item["i"])
        if not fixed or fixed == text or not w or not item.get("queued") or item.get("sent_now") or item.get("cancelled"):
            return
        prompt, said = w
        if not isinstance(prompt, str) or text not in prompt:
            return
        s.waiting[item["i"]] = (prompt.replace(text, fixed, 1), said.replace(text, fixed, 1) if isinstance(said, str) else said)
        item["text"] = fixed
        s.changed(item)
        s.save_pending()

    def ui_action(self, s, action, **args):
        """Claude showing the user something in the window (see Session.ui_tools). Returns what happened."""
        if self.active is not s:
            return "Not shown: the user has another conversation open in Yo Claude right now."
        if action == "panel":
            tab = args.get("tab", "files")
            if tab not in ("files", "changes", "git", "tasks", "close"):
                return "Unknown tab: use files, changes, git, tasks or close."
            self.emit("ui", action="panel", tab=tab)
            return f"Showing the {tab} tab." if tab != "close" else "Closed the panel."
        path = (args.get("path") or "").strip().strip('"')
        full = os.path.normpath(path if os.path.isabs(path) or not s.cwd else os.path.join(s.cwd, path))
        if not os.path.exists(full):
            return f"Not found: {full}"
        rel = None
        if s.cwd and same_folder(os.path.commonpath([os.path.normcase(full), os.path.normcase(s.cwd)]), s.cwd):
            rel = os.path.relpath(full, s.cwd).replace("\\", "/")
            rel = "" if rel == "." else rel
        if action == "folder":
            if rel is None:
                return "Only folders inside this session's folder can be shown in the files panel."
            if not os.path.isdir(full):   # a file: show it in its folder, highlighted
                self.emit("ui", action="folder", rel=os.path.dirname(rel).replace("\\", "/"), select=rel)
                return f"Showing {rel} in the files panel."
            self.emit("ui", action="folder", rel=rel, select=rel)
            return f"Showing {rel or 'the session folder'} in the files panel."
        if action == "file":
            if os.path.isdir(full):
                return "That's a folder: use show_folder."
            self.emit("ui", action="file", path=full, rel=rel)
            return f"Opened {os.path.basename(full)} in the viewer."
        if action == "diff":
            if rel is None:
                return "Only files in this session's folder have a diff here."
            self.emit("ui", action="diff", rel=rel)
            return f"Showing the changes in {rel}."
        return "Unknown action."

    def say_short(self, sid, i):
        """The short spoken version of Claude's message `i`: said out loud and shown as a voice bubble under it."""
        s = self.live.get(sid)
        if not s or not (0 <= i < len(s.items)) or s.items[i].get("kind") != "assistant":
            return {"error": "That message isn't there any more."}
        done = next((x for x in s.items if x.get("kind") == "spoken" and x.get("for") == i), None)
        if done:   # already have it: just say it again
            self.emit("announce", session=sid, text=done["text"])
            return {}

        async def make():
            _, reply, asked = s.last_exchange(upto=i)
            try:
                line, mood = await spoken_line(self.title_of(sid), asked, reply, short_version=True)
                if mood:
                    self.emit("mood", session=sid, mood=mood, clip=MOODS[mood])
            except Exception as e:
                log.warning("Couldn't write the short version: %s", e)
                self.emit("notice", text="Couldn't make the short version just now.")
                return
            if line:
                s.add_spoken(i, line, say=True)
        self.run(make())
        return {}

    def say_again(self, text):
        self.emit("announce", text=text)
        return {}

    def tidy(self, text, sid=None):
        """Your message with its spelling and grammar fixed (tidy_text), with Claude's last message in the session
        as context. A concurrent Future with the text; the text unchanged if the setting is off."""
        s = self.live.get(sid) if sid else self.active
        context = ""
        if s is not None:
            context = next((x.get("text", "") for x in reversed(s.items) if x.get("kind") == "assistant"), "")
        if not self.settings.get("fix_text", True):
            async def unchanged():
                return text
            return self.run(unchanged())
        return self.run(tidy_text(text, context))

    # --- /btw: side questions that never land in the conversation (see side_chat) ---
    def btw_ask(self, sid, question, bid=None):
        """Ask a side question about session `sid`. With the `bid` of its open side chat it's a follow-up there;
        otherwise a new side chat starts (closing any other one for that session). Works while Claude is busy in
        the session. Answers come as "btw" events. Returns {"btw": id} or {"error": ...}."""
        s = self.live.get(sid)
        question = (question or "").strip()
        if not s or not question:
            return {"error": "Open a session and type a question."}
        side = self.btw.get(sid)
        if side and side["id"] != bid:
            self.btw_close(sid)
            side = None
        if not side:
            if not os.path.isfile(self.session_file(sid, s.cwd)[1]):
                return {"error": "Nothing to ask about yet: this conversation hasn't started."}
            bid = uuid.uuid4().hex[:12]
            side = {"id": bid, "queue": asyncio.Queue(), "live": {}}

            def emit(state, text=""):
                self.emit("btw", session=sid, btw=bid, state=state, text=text)
            model = s.model or (None if s.cwd else CHAT_MODEL)
            side["future"] = self.run(side_chat(sid, s.cwd, side["queue"], emit, model=model, mark=s.rewind_mark(),
                                                extra_dirs=s.extra_dirs, settings=json.dumps(self.loadout_settings()),
                                                live=side["live"]))
            self.btw[sid] = side
            # it ended by itself (an error): the next question starts a new one
            side["future"].add_done_callback(
                lambda f: self.btw.pop(sid, None) if self.btw.get(sid) is side else None)
        if s.busy:   # its reply so far isn't in the saved conversation yet, so the fork sees an unanswered message
            question = BTW_BUSY_NOTE + question
        self.loop.call_soon_threadsafe(side["queue"].put_nowait, question)
        return {"btw": side["id"]}

    def btw_close(self, sid, bid=None):
        """Close (and forget) session `sid`'s side chat, stopping an answer still coming."""
        side = self.btw.get(sid)
        if side and (bid is None or side["id"] == bid):
            self.btw.pop(sid, None)
            live, client = side["live"], side["live"].get("client")
            live["closed"] = True
            # end it the gentle way (stop the answer, then no more questions) so claude.exe exits by itself; a bare
            # cancel can skip the SDK's terminate step and leave the process running. Cancel only as a fallback.
            self.loop.call_soon_threadsafe(side["queue"].put_nowait, None)
            if client and live.get("answering"):
                self.run(client.interrupt())
            self.loop.call_soon_threadsafe(self.loop.call_later, 30, side["future"].cancel)
        return {}

    def retry(self, sid=None):
        """Send your last message in a session again (after an error)."""
        s = self.live.get(sid) if sid else self.active
        last = next((i for i in reversed(s.items) if i.get("kind") == "user"), None) if s else None
        if not last:
            return {"error": "There's no message of yours to send again."}
        if s.busy:
            return {"error": "Claude is already working in this session."}
        self.run(s.turn(("[voice] " if last.get("voice") else "") + last.get("text", ""), bool(last.get("voice"))))
        return {}

    def reorder_queue(self, sid, order):
        """You dragged the queued messages into a new order: `order` is their indexes, first to go first."""
        s = self.live.get(sid)
        if not s:
            return {"error": "That session isn't open."}
        order = [int(i) for i in order or [] if str(i).lstrip("-").isdigit()]

        def apply():
            want = [i for i in order if i in s.order]
            s.order[:] = want + [i for i in s.order if i not in want]
            for k, i in enumerate(s.order):   # (the window shows them in this order)
                s.items[i]["qpos"] = k
                s.changed(s.items[i])
            s.save_pending()
        self.loop.call_soon_threadsafe(apply)
        return {}

    def cancel_queued(self, sid, i):
        """Take back a message that's still waiting its turn. Returns its text and attachments for the box."""
        s = self.live.get(sid)
        item = s.items[i] if s and 0 <= i < len(s.items) else None
        if not item or item.get("kind") != "user" or not item.get("queued") or item.get("sent_now"):
            return {"error": "That message has already been sent."}
        item.update(cancelled=True, queued=False, kind="cancelled")
        s.changed(item)
        return {"text": item.get("text", ""), "attachments": item.get("attachments", [])}

    def send_now(self, sid, i):
        """Give a queued message to Claude now, during the reply in progress (see Session.send_now)."""
        s = self.live.get(sid)
        item = s.items[i] if s and 0 <= i < len(s.items) else None
        if not item:
            return {"error": "That message isn't there any more."}
        try:
            err = self.run(s.send_now(item)).result(10)
        except Exception as e:
            log.warning("send now: %s", e)
            return {"error": f"Couldn't send it now: {e}"}
        return {"error": err} if err else {}

    def interrupt(self, sid=None):
        s = self.live.get(sid) if sid else self.active
        if not s:
            return
        for future in list(s.approvals.values()):
            self.loop.call_soon_threadsafe(lambda f=future: f.done() or f.set_result((False, False)))
        self.loop.call_soon_threadsafe(s.let_go)
        if s.client and s.busy:
            self.run(s.client.interrupt())

    def approve(self, sid, aid, allow, always=False):
        s = self.live.get(sid)
        future = s and s.approvals.get(aid)
        if future:
            self.loop.call_soon_threadsafe(lambda: future.done() or future.set_result((allow, always)))

    def checklist_answer(self, sid, cid, picks, note=""):
        """[submit] on a checklist card: the card shows your answers, and they go to Claude as your next message
        (queued like any other while Claude is busy). picks: one {"yes": bool, "why": str} per item, in order."""
        s = self.live.get(sid)
        item = s and next((x for x in s.items if x.get("kind") == "checklist" and x.get("id") == cid), None)
        if not item or item.get("status") != "pending" or not isinstance(picks, list) or len(picks) != len(item["items"]):
            return {"error": "That checklist has been answered already."}
        picks = [{"item": x, "yes": bool((p or {}).get("yes")), "why": " ".join(str((p or {}).get("why") or "").split())}
                 for x, p in zip(item["items"], picks)]
        note = (note or "").strip()
        item.update(status="answered", picks=picks, note=note)
        s.changed(item)
        lines = [("✓ yes: " if p["yes"] else "✗ no: ") + p["item"] + (f"  (why: {p['why']})" if p["why"] else "")
                 for p in picks]
        text = (f"My answers to \"{item['title']}\" (ticked = yes):\n" + "\n".join(lines)
                + (f"\n\nNote: {note}" if note else ""))
        self.send(text, sid=sid)
        return {}

    def answer(self, sid, aid, answers):
        """The user's answers to Claude's AskUserQuestion ({question: label(s)}), or None to skip it."""
        s = self.live.get(sid)
        future = s and s.approvals.get(aid)
        if future:
            self.loop.call_soon_threadsafe(lambda: future.done() or future.set_result(answers))

    def set_permission_mode(self, sid, mode):
        if mode not in ("auto", "default", "acceptEdits", "plan"):
            return
        s = self.live.get(sid)   # this session only: new sessions always start in auto
        if not s:
            return
        s.permission_mode = mode
        if s.client:
            self.run(s.client.set_permission_mode(mode))

    def set_model(self, sid, model):
        """Per session; also the default for new sessions. A live session switches at once."""
        model = model or None
        self.settings["model"] = model or ""
        self.settings.save()
        s = self.live.get(sid)
        if s:
            s.model = model
            if s.client:
                self.run(s.client.set_model(model or (None if s.cwd else CHAT_MODEL)))

    def set_effort(self, sid, effort):
        """Per session; also the default for new sessions. Applies from the next message (it's a start-up option)."""
        effort = effort if effort in ("low", "medium", "high", "xhigh", "max") else None
        self.settings["effort"] = effort or ""
        self.settings.save()
        s = self.live.get(sid)
        if s:
            s.effort = effort
            if s.client and not s.busy:
                self.run(s.disconnect())

    def reconnect_all(self):
        """Settings that change the CLI's options (PC control) apply from the next turn."""
        for s in self.live.values():
            if s.client and not s.busy:
                self.run(s.disconnect())

    # --- management ---
    def rename(self, sid, cwd, title):
        try:
            sdk.rename_session(sid, title, directory=cwd or CHAT_DIR)
        except Exception as e:
            log.warning("rename_session failed (%s); keeping the name in Yo Claude only", e)
        self.meta.update(sid, title=title)
        self.sessions_changed(cwd)

    def pin(self, sid, cwd, pinned):
        self.meta.update(sid, pinned=bool(pinned))
        self.sessions_changed(cwd)

    def group(self, sid, cwd, group):
        self.meta.update(sid, group=group or None)
        self.sessions_changed(cwd)

    def session_file(self, sid, cwd):
        folder = os.path.join(PROJECTS_DIR, sdk.project_key_for_directory(cwd or CHAT_DIR))
        return folder, os.path.join(folder, f"{sid}.jsonl")

    def stale(self):
        """Sessions worth cleaning up, oldest first: empty ones, short ones a week old, and anything untouched for
        STALE_DAYS. Never pinned, open, busy, or touched in the last QUIET_DAYS."""
        now = time.time() * 1000
        out = []
        for cwd in [None] + self.workspaces():
            try:
                infos = sdk.list_sessions(directory=cwd or CHAT_DIR)
            except Exception as e:
                log.warning("list_sessions failed for %s: %s", cwd, e)
                continue
            for s in infos:
                m = self.meta.data["sessions"].get(s.session_id, {})
                if m.get("pinned") or s.session_id in self.live or s.session_id in self.work:
                    continue
                days = (now - (s.last_modified or now)) / 86_400_000
                if days < QUIET_DAYS:
                    continue
                size = s.file_size or 0
                if size < EMPTY_BYTES or not (s.first_prompt or s.custom_title or s.summary):
                    reason = "empty"
                elif size < SMALL_BYTES:
                    reason = f"short, untouched for {int(days)} days"
                elif days >= STALE_DAYS:
                    reason = f"untouched for {int(days)} days"
                else:
                    continue
                out.append({"id": s.session_id, "cwd": cwd, "reason": reason, "modified": s.last_modified,
                            "size": size, "source": m.get("source", "claude code"),
                            "title": m.get("title") or s.custom_title or s.summary or s.first_prompt or "(empty)"})
        out.sort(key=lambda x: x["modified"] or 0)
        return out[:200]

    def delete_many(self, items):
        """Move several sessions to the trash; returns the ones that couldn't be moved, with why."""
        failed, folders = [], set()
        for it in items:
            err = self.delete(it["id"], it.get("cwd"), notify=False)
            if err:
                failed.append({"id": it["id"], "error": err})
            folders.add(it.get("cwd"))
        for cwd in folders:
            self.sessions_changed(cwd)
        return failed

    def delete(self, sid, cwd, notify=True):
        """Move a session to Yo Claude's trash (restorable). Refused while it's busy or was written in the last minute,
        which probably means it's open in another Claude Code window."""
        s = self.live.get(sid)
        if s and s.busy:
            return "It's still working."
        folder, path = self.session_file(sid, cwd)
        if not os.path.exists(path):
            return "Couldn't find that session's file."
        if time.time() - os.path.getmtime(path) < 60 and not s:
            return "It changed in the last minute, so it may be open somewhere else."
        if s:
            self.run(s.disconnect()).result(10)
            self.live.pop(sid, None)
            if self.active is s:
                self.active = None
        dest = os.path.join(TRASH_DIR, os.path.basename(folder))
        os.makedirs(dest, exist_ok=True)
        shutil.move(path, os.path.join(dest, f"{sid}.jsonl"))
        if os.path.isdir(os.path.join(folder, sid)):   # its subagent transcripts
            shutil.move(os.path.join(folder, sid), os.path.join(dest, sid))
        self.meta.update(sid, deleted={"at": time.time(), "from": folder}, cwd=cwd)
        if notify:
            self.sessions_changed(cwd)
        return None

    def trash(self):
        out = []
        for sid, m in self.meta.data["sessions"].items():
            if m.get("deleted"):
                out.append({"id": sid, "title": m.get("title") or sid[:8], "cwd": m.get("cwd"),
                            "deleted": m["deleted"]["at"]})
        return sorted(out, key=lambda x: x["deleted"], reverse=True)

    def restore(self, sid):
        m = self.meta.session(sid)
        info = m.get("deleted")
        if not info:
            return "Not in the trash."
        folder = info["from"]
        src = os.path.join(TRASH_DIR, os.path.basename(folder))
        os.makedirs(folder, exist_ok=True)
        shutil.move(os.path.join(src, f"{sid}.jsonl"), os.path.join(folder, f"{sid}.jsonl"))
        if os.path.isdir(os.path.join(src, sid)):
            shutil.move(os.path.join(src, sid), os.path.join(folder, sid))
        m.pop("deleted", None)
        self.meta.save()
        self.sessions_changed(m.get("cwd"))
        return None

    def fork(self, sid, cwd):
        try:
            result = sdk.fork_session(sid, directory=cwd or CHAT_DIR)
        except Exception as e:
            return None, str(e)
        new_id = getattr(result, "session_id", None) or getattr(result, "new_session_id", None)
        if new_id:
            self.meta.update(new_id, source="yoclaude", cwd=cwd)
        self.sessions_changed(cwd)
        return new_id, None


def pc_control_server():
    """The screen-control server bundled in pc_control/ (its own environment: its packages clash with the SDK's)."""
    python = os.path.join(HERE, "pc_control", ".venv", "Scripts", "python.exe")
    if not os.path.exists(python):
        return None
    os.makedirs(PC_CONTROL_DATA, exist_ok=True)
    return {"type": "stdio", "command": python, "args": [os.path.join(HERE, "pc_control", "server.py")],
            "env": {"SCREEN_CONTROL_LOG": os.path.join(PC_CONTROL_DATA, "screen-control.log"),
                    "SCREEN_CONTROL_MACROS": os.path.join(PC_CONTROL_DATA, "macros"),
                    "SCREEN_CONTROL_KILL_FILE": os.path.join(PC_CONTROL_DATA, "DISABLED")}}


def exit_code(path):
    """Claude Code ends a background command's output file with "[exited with code N]": N, or None while it runs."""
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            f.seek(max(0, os.path.getsize(path) - 200))
            found = re.findall(rb"\[exited with code (-?\d+)\]", f.read())
    except OSError:
        return None
    return int(found[-1]) if found else None


def running_shells():
    """Command lines of the shells running now (Claude Code runs background commands in Git Bash), or None if
    Windows couldn't say."""
    try:
        import win32com.client
        wmi = win32com.client.GetObject("winmgmts:")
        return [p.CommandLine or "" for p in wmi.ExecQuery(
            "SELECT CommandLine FROM Win32_Process WHERE Name='bash.exe' OR Name='sh.exe'")]
    except Exception as e:
        log.debug("Couldn't list shells: %s", e)
        return None


def task_command(t):
    """A background command's text. Tasks saved before it was recorded have it as their description, unless Claude
    gave one."""
    if t.get("command"):
        return t["command"]
    d = t.get("description") or ""
    return d if t.get("type") == "local_bash" and re.search(r"[|;&>]|^\S+ -", d) else None


def command_running(command, shells):
    """Whether one of those shells is running this command. Its longest stretch without quotes or backslashes is
    matched, since the shell's command line has the command quoted inside it."""
    if not command or not shells:
        return False
    parts = sorted(re.split(r"[\\'\"`]", command), key=len, reverse=True)
    key = parts[0].strip() if parts else ""
    return len(key) >= 12 and any(key in c for c in shells)


def finished_card(code):
    """How a background command's card should read once its output shows how it ended."""
    if code is None:
        return {"status": "stopped", "summary": "Its process has ended, but how it ended isn't known."}
    return {"status": "completed" if code == 0 else "failed", "summary": f"Ran to the end (exit code {code})."}


def pid_alive(pid):
    if not pid:
        return False
    handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, int(pid))   # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    code = ctypes.c_ulong()
    ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(handle)
    return code.value == 259   # STILL_ACTIVE


def same_folder(a, b):
    if not a or not b:
        return not a and not b
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
