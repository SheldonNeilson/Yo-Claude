"""Yo Claude - a "Hey Siri" style voice assistant for Windows.

Say "yo claude" (or click the bar / tray icon), Claude greets you, you speak, the speech is transcribed locally
(faster-whisper), sent to Claude through the logged-in Claude Code CLI, and the answer is read aloud in a
Microsoft neural voice (edge-tts). A floating bar at the bottom of the screen shows what it's doing, and a tray
icon switches the wake word, voice replies and PC control on and off.

    pythonw yo_claude.py             # normal
    python yo_claude.py --debug      # with a console, logging what the wake engine hears
    python yo_claude.py --say "hi"   # just speak a line

Everything it writes lives in ~/.yoclaude (settings.json, yo_claude.log, models).
"""

import argparse
import asyncio
import io
import json
import logging
import os
import queue
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
import wave
import winsound
from collections import deque
from concurrent.futures import ThreadPoolExecutor

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
# Not under AppData: apps from the Microsoft Store (like the Claude desktop app) get a private copy of AppData,
# so files written there from their child processes are invisible to everything else.
DATA_DIR = os.path.join(os.path.expanduser("~"), ".yoclaude")

# --- settings -----------------------------------------------------------------
WAKE_PHRASE = "yo claude"
VOSK_MODEL = os.path.join(DATA_DIR, "models", "vosk-model-small-en-us-0.15")
WHISPER_MODEL = "small.en"   # tiny.en / base.en / small.en / medium.en
CLAUDE_MODEL = "sonnet"
WEB_TOOLS = ["WebSearch", "WebFetch"]
PC_CONTROL_SERVER = "screen-control"   # MCP server from ~/.claude.json handed to Claude when PC control is on
CLAUDE_TIMEOUT_S = 180
PC_CONTROL_TIMEOUT_S = 600
CONVERSATION_WINDOW_S = 300  # a wake within this long after the last answer continues the chat
FOLLOWUP_LISTEN_S = 6        # after answering, listen this long for a follow-up without the wake word
SPEECH_START_TIMEOUT_S = 7
END_SILENCE_S = 1.5          # pause that ends your request
MAX_UTTERANCE_S = 30
VAD_ON, VAD_OFF = 0.5, 0.35  # Silero speech probability thresholds
NEURAL_VOICE = "en-US-AvaNeural"   # `edge-tts --list-voices` for others
NEURAL_RATE = "+5%"
TEXT_HOLD_S = 12             # how long a reply stays on the bar when voice replies are off

DEFAULT_SETTINGS = {"listening": True, "voice_replies": True, "pc_control": False, "bar_when_idle": True}

GREETINGS = ["Hey, how can I help?", "Yo! What do you need?", "How can I help?", "What's up?", "I'm listening."]
DIDNT_HEAR = "I didn't hear anything."
DIDNT_CATCH = "Sorry, I didn't catch that."
OKAY = "Okay."
STOP_PHRASES = {"never mind", "nevermind", "cancel", "stop", "nothing", "no thanks", "thats all", "goodbye", "bye"}

SYSTEM_PROMPT = (
    "You are Claude, talking to the user by voice through a wake-word assistant on their Windows PC. "
    "Your reply is read aloud by text-to-speech, so answer in plain conversational sentences: no markdown, "
    "lists, headings, code blocks, URLs or emoji. Keep it short, one to three sentences, unless the user asks "
    "for detail. Their words came from speech recognition and may contain mistakes; interpret them sensibly."
)
PC_CONTROL_PROMPT = (
    " You can see and control the user's screen, keyboard and mouse with the screen-control tools; use them "
    "when the user asks you to do something on their PC, then say briefly what you did. Before anything hard "
    "to undo (deleting, sending, posting, buying, submitting), ask the user to confirm and wait for their reply."
)

SAMPLE_RATE = 16000
FRAME_LENGTH = 512
FPS = SAMPLE_RATE / FRAME_LENGTH
TTS_RATE = 24000
IDLE, PAUSED, LISTENING, THINKING, SPEAKING = "idle", "paused", "listening", "thinking", "speaking"

log = logging.getLogger("yo_claude")


class Settings(dict):
    path = os.path.join(DATA_DIR, "settings.json")

    def __init__(self):
        super().__init__(DEFAULT_SETTINGS)
        try:
            with open(self.path, encoding="utf-8") as f:
                self.update(json.load(f))
        except (OSError, ValueError):
            pass

    def save(self):
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self, f, indent=2)


# --- audio in -----------------------------------------------------------------
def rms(frame):
    return float(np.sqrt(np.mean(frame.astype(np.float32) ** 2))) if len(frame) else 0.0


class Mic:
    def __init__(self):
        from pvrecorder import PvRecorder
        self.rec = PvRecorder(frame_length=FRAME_LENGTH, device_index=-1)
        log.info("Mic: %s", self.rec.selected_device)

    @property
    def running(self):
        return self.rec.is_recording

    def start(self):
        if not self.rec.is_recording:
            self.rec.start()

    def stop(self):
        if self.rec.is_recording:
            self.rec.stop()

    def read(self):
        return np.array(self.rec.read(), dtype=np.int16)


class Vad:
    """Silero speech probability for the latest frame (the model ships with faster-whisper)."""

    def __init__(self):
        from faster_whisper.vad import get_vad_model
        self.model = get_vad_model()
        self.reset()

    def reset(self):
        self.window = np.zeros(FRAME_LENGTH * 16, np.float32)

    def __call__(self, frame):
        self.window = np.roll(self.window, -FRAME_LENGTH)
        self.window[-FRAME_LENGTH:] = frame / 32768.0
        return float(self.model(self.window)[-1])


class VoskWake:
    """Free offline wake word: a recognizer that only knows WAKE_PHRASE plus sound-alike decoys.

    The decoys give near-misses ("yo, close the door", "your cloud bill") something else to match. Only finished
    utterances count (partials jump to the phrase too eagerly); since background noise can stop Vosk ever noticing
    that you stopped talking, the VAD's pause forces the result.
    """

    DECOYS = ["yo", "you", "your", "close", "closed", "cloud", "claudia", "clod", "clause", "claws", "loud", "go",
              "load", "though", "hello", "what", "the", "a", "it", "is", "to", "glad", "called"]

    def __init__(self, phrase=WAKE_PHRASE):
        import vosk
        vosk.SetLogLevel(-1)
        self.phrase = phrase
        grammar = [phrase] + self.DECOYS + ["[unk]"]
        self.rec = vosk.KaldiRecognizer(vosk.Model(VOSK_MODEL), SAMPLE_RATE, json.dumps(grammar))
        self.speech = self.quiet = 0
        self.last_text = None   # text of the utterance that just finished, if one did on this frame

    def feed(self, frame, speech_prob):
        self.last_text = None
        if self.rec.AcceptWaveform(frame.tobytes()):
            text = json.loads(self.rec.Result())["text"]
            self.speech = self.quiet = 0
        else:
            if speech_prob > VAD_ON:
                self.speech, self.quiet = self.speech + 1, 0
            elif self.speech:
                self.quiet += 1
            if not self.speech or (self.quiet < 8 and self.speech < 4 * FPS):
                return False
            text = json.loads(self.rec.FinalResult())["text"]
            self.speech = self.quiet = 0
        if text:
            log.debug("Wake engine heard: %s", text)
        self.last_text = text
        return self.phrase in text

    def reset(self):
        self.rec.Reset()
        self.speech = self.quiet = 0


class Utterance:
    """Collects one spoken request: starts when the VAD hears speech, ends after END_SILENCE_S of non-speech."""

    def __init__(self, start_timeout_s, followup):
        self.start_timeout_s, self.followup = start_timeout_s, followup
        self.pre = deque(maxlen=int(FPS * 0.5))
        self.audio, self.on, self.off, self.waited = [], 0, 0, 0

    def feed(self, frame, p):
        """None while still listening, ("timeout", None) if nobody spoke, ("done", pcm) when finished."""
        if not self.audio:
            self.pre.append(frame)
            self.on = self.on + 1 if p > VAD_ON else 0
            if self.on >= 3:
                self.audio = list(self.pre)
            else:
                self.waited += 1
                if self.waited > self.start_timeout_s * FPS:
                    return "timeout", None
            return None
        self.audio.append(frame)
        self.off = self.off + 1 if p < VAD_OFF else 0
        if self.off >= END_SILENCE_S * FPS or len(self.audio) >= MAX_UTTERANCE_S * FPS:
            return "done", np.concatenate(self.audio)
        return None


class Transcriber:
    def __init__(self):
        from faster_whisper import WhisperModel
        t = time.time()
        try:   # no network check on every start once the model is downloaded
            self.model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8", local_files_only=True)
        except Exception:
            self.model = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        list(self.model.transcribe(np.zeros(SAMPLE_RATE, np.float32), language="en")[0])   # first run is ~5x slower
        log.info("Whisper %s loaded in %.1fs", WHISPER_MODEL, time.time() - t)

    def __call__(self, pcm):
        t = time.time()
        segments, _ = self.model.transcribe(pcm.astype(np.float32) / 32768.0, language="en", beam_size=1)
        text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()
        log.info("Heard (%.1fs): %r", time.time() - t, text)
        return text


# --- audio out ----------------------------------------------------------------
def neural_tts(text, voice=NEURAL_VOICE, rate=TTS_RATE):
    """Microsoft neural voice (online) -> mono int16 PCM at `rate`."""
    import av
    import edge_tts

    async def fetch():
        mp3 = bytearray()
        async for chunk in edge_tts.Communicate(text, voice, rate=NEURAL_RATE).stream():
            if chunk["type"] == "audio":
                mp3 += chunk["data"]
        return bytes(mp3)

    container = av.open(io.BytesIO(asyncio.run(fetch())))
    resampler = av.AudioResampler(format="s16", layout="mono", rate=rate)
    frames = [f for frame in container.decode(audio=0) for f in resampler.resample(frame)]
    frames += resampler.resample(None)
    return np.concatenate([f.to_ndarray().reshape(-1) for f in frames]).astype(np.int16)


def write_wav(path, pcm, rate):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


class Speaker:
    """Always the same neural voice; if the voice service can't be reached the reply is shown as text instead."""

    def __init__(self):
        self.cache = {}
        self.pcm = None
        self.started = self.until = 0.0
        self.n = 0

    def synth(self, text):
        if text in self.cache:
            return self.cache[text]
        for attempt in range(3):
            try:
                return neural_tts(text)
            except Exception as e:
                log.warning("Voice attempt %d failed: %s", attempt + 1, e)
                time.sleep(0.3)
        return None

    def warm(self, phrases):
        for p in phrases:
            pcm = self.synth(p)
            if pcm is not None:
                self.cache[p] = pcm

    def play(self, pcm):
        self.n += 1
        path = os.path.join(DATA_DIR, f"speech-{self.n % 3}.wav")
        write_wav(path, pcm, TTS_RATE)
        winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
        self.pcm, self.started = pcm, time.time()
        self.until = self.started + len(pcm) / TTS_RATE + 0.15

    @property
    def busy(self):
        return time.time() < self.until

    def level(self):
        """Loudness of what's playing right now, for the waveform."""
        i = int((time.time() - self.started) * TTS_RATE)
        return rms(self.pcm[i:i + 768]) if self.pcm is not None else 0.0

    def stop(self):
        winsound.PlaySound(None, 0)
        self.until = 0.0


def speakable(text):
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^\s*(#+|[-*•]|\d+\.)\s+", "", text, flags=re.M)
    text = re.sub(r"[*_`#>|]", "", text)
    return re.sub(r"\s+", " ", text).strip()


# --- Claude -------------------------------------------------------------------
class Claude:
    def __init__(self, settings):
        self.settings = settings
        self.exe = shutil.which("claude") or os.path.expanduser(r"~\.local\bin\claude.exe")
        self.workdir = os.path.join(DATA_DIR, "home")   # outside any project, so no project CLAUDE.md/MCP loads
        os.makedirs(self.workdir, exist_ok=True)
        self.session_id = None
        self.last_answer_at = 0.0
        self.proc = None

    def pc_control_config(self):
        """MCP config holding just the screen-control server, copied from the user's Claude Code config."""
        try:
            with open(os.path.expanduser("~/.claude.json"), encoding="utf-8") as f:
                server = json.load(f)["mcpServers"][PC_CONTROL_SERVER]
        except (OSError, ValueError, KeyError):
            log.warning("PC control is on but no %r MCP server is configured in ~/.claude.json", PC_CONTROL_SERVER)
            return None
        path = os.path.join(DATA_DIR, "pc-control-mcp.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"mcpServers": {PC_CONTROL_SERVER: server}}, f)
        return path

    def ask(self, prompt):
        """Claude's reply, or None if cancelled."""
        if time.time() - self.last_answer_at > CONVERSATION_WINDOW_S:
            self.session_id = None
        tools, system, timeout = list(WEB_TOOLS), SYSTEM_PROMPT, CLAUDE_TIMEOUT_S
        # Only the web tools (Claude Code's full coding toolset is ~35k tokens of context per question), and no
        # user settings, so your hooks, plugins and skills don't run or load for voice questions.
        cmd = [self.exe, "-p", "--output-format", "json", "--model", CLAUDE_MODEL,
               "--permission-mode", "default", "--strict-mcp-config", "--setting-sources", "project,local",
               "--tools", ",".join(WEB_TOOLS)]
        if self.settings["pc_control"] and (config := self.pc_control_config()):
            cmd += ["--mcp-config", config]
            tools.append(f"mcp__{PC_CONTROL_SERVER}")
            system += PC_CONTROL_PROMPT
            timeout = PC_CONTROL_TIMEOUT_S
        cmd += ["--allowedTools", ",".join(tools), "--append-system-prompt", system]
        cmd += ["--resume", self.session_id] if self.session_id else ["--session-id", str(uuid.uuid4())]
        t = time.time()
        log.debug("Claude command: %s", cmd)
        self.proc = proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            text=True, encoding="utf-8", cwd=self.workdir,
                                            creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            stdout, stderr = proc.communicate(prompt, timeout=timeout)
        except subprocess.TimeoutExpired:
            self.cancel()
            return "Sorry, that took too long. Try again?"
        finally:
            self.proc = None
        if getattr(proc, "cancelled", False):
            return None
        try:
            out = json.loads(stdout)
        except json.JSONDecodeError:
            log.error("Claude output: %s %s", stdout[-500:], stderr[-500:])
            return "Sorry, I couldn't reach Claude."
        u = out.get("usage") or {}
        log.info("Claude answered in %.1fs (exit %s, %d context tokens, %d cached)", time.time() - t, proc.returncode,
                 u.get("input_tokens", 0) + u.get("cache_creation_input_tokens", 0) + u.get("cache_read_input_tokens", 0),
                 u.get("cache_read_input_tokens", 0))
        self.session_id = out.get("session_id") or self.session_id
        self.last_answer_at = time.time()
        if out.get("is_error"):
            log.error("Claude error: %s", out)
            return "Sorry, something went wrong on my end."
        return out.get("result") or "I don't have an answer for that."

    def cancel(self):
        proc = self.proc
        if proc and proc.poll() is None:
            proc.cancelled = True
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)


# --- the assistant ------------------------------------------------------------
def is_stop(text):
    return re.sub(r"[^a-z ]", "", text.lower()).strip() in STOP_PHRASES


class Assistant:
    """Runs on its own thread: reads the mic continuously and moves between idle/listening/thinking/speaking.

    `emit(kind, **data)` reports to the UI ("state", "level"); `commands` takes "talk", "stop", "settings", "quit".
    """

    def __init__(self, settings, emit, commands, save_samples=False, collect=False):
        self.settings, self.emit, self.commands = settings, emit, commands
        self.save_samples = save_samples or collect
        self.collect = collect   # --collect: only judge and save what it hears, never reply
        self.hits = self.tries = 0
        self.recent = deque(maxlen=int(FPS * 6))
        self.heard_speech = False
        self.emit("state", state="starting", text="")
        self.mic = Mic()
        self.vad = Vad()
        self.wake = VoskWake()
        self.stt = Transcriber()
        self.speaker = Speaker()
        self.claude = Claude(settings)
        self.worker = ThreadPoolExecutor(1)
        self.job = self.utterance = None
        self.generation = 0          # bumps on stop, so a cancelled job's late result is ignored
        self.after_speaking = None
        self.state = None
        self.quit = False
        threading.Thread(target=self.speaker.warm, args=(GREETINGS + [DIDNT_HEAR, DIDNT_CATCH, OKAY],),
                         daemon=True).start()
        self.go_idle()
        log.info("Ready.")

    # state changes
    def set_state(self, state, text="", hold=0.0):
        if state != self.state or text:
            log.info("[%s] %s", state, text)
        self.state = state
        self.emit("state", state=state, text=text, hold=hold)

    def go_idle(self, text="", hold=0.0):
        self.wake.reset()
        self.set_state(IDLE if self.settings["listening"] else PAUSED, text, hold)

    def listen(self, timeout_s=SPEECH_START_TIMEOUT_S, followup=False, text=""):
        self.vad.reset()
        self.utterance = Utterance(timeout_s, followup)
        self.utterance.text = text
        self.set_state(LISTENING, text)

    def say(self, text, then, pcm=None):
        """Speak `text` (or just show it when voice replies are off / the voice is unavailable), then call `then`."""
        if self.settings["voice_replies"] and pcm is None:
            pcm = self.speaker.synth(text)
        if self.settings["voice_replies"] and pcm is not None:
            self.speaker.play(pcm)
            self.after_speaking = lambda: then(text)
            self.set_state(SPEAKING, text)
        else:
            then(text)

    def start_conversation(self):
        self.mic.start()
        self.say(random.choice(GREETINGS), lambda _: self.listen())

    def stop(self):
        self.generation += 1
        self.claude.cancel()
        self.speaker.stop()
        self.job = None
        self.go_idle()

    # main loop
    def run(self):
        try:
            while not self.quit:
                self.handle_commands()
                if self.state == PAUSED:
                    self.mic.stop()
                    time.sleep(0.05)
                    continue
                self.mic.start()
                frame = self.mic.read()
                p = self.vad(frame)
                level = self.speaker.level() if self.state == SPEAKING else rms(frame)
                self.emit("level", level=level, speech=p > VAD_ON)
                getattr(self, "on_" + self.state)(frame, p)
        except Exception:
            log.exception("Assistant crashed")
            self.set_state("error", "Something broke. See the log (tray menu).")
        finally:
            self.claude.cancel()
            self.speaker.stop()
            self.mic.stop()

    def handle_commands(self):
        while True:
            try:
                cmd = self.commands.get_nowait()
            except queue.Empty:
                return
            if cmd == "quit":
                self.quit = True
            elif cmd == "stop":
                self.stop()
            elif cmd == "talk" and self.state in (IDLE, PAUSED):   # while active, only "stop" stops it
                self.start_conversation()
            elif cmd == "settings" and self.state in (IDLE, PAUSED):
                self.go_idle()

    def on_idle(self, frame, p):
        self.recent.append(frame)
        self.heard_speech = self.heard_speech or p > VAD_ON
        woke = self.wake.feed(frame, p)
        if self.save_samples and self.wake.last_text is not None and self.heard_speech:
            self.save_sample(self.wake.last_text or "nothing")
            self.heard_speech = False
            if self.collect:   # show every judgement instead of replying
                self.hits += woke
                self.tries += 1
                self.set_state(IDLE, f"Heard “{self.wake.last_text or '(nothing)'}” – "
                                     f"woke {self.hits} of {self.tries} times", hold=30)
        if woke and self.collect:
            winsound.MessageBeep(winsound.MB_OK)
        elif woke:
            log.info("Wake word heard")
            self.start_conversation()

    def save_sample(self, label):
        """--debug: keep what the wake engine just judged, to tune it against real voices."""
        folder = os.path.join(DATA_DIR, "samples")
        os.makedirs(folder, exist_ok=True)
        name = time.strftime("%Y%m%d-%H%M%S-") + re.sub(r"\W+", "_", label)[:40] + ".wav"
        write_wav(os.path.join(folder, name), np.concatenate(self.recent), SAMPLE_RATE)
        self.recent.clear()

    def on_listening(self, frame, p):
        result = self.utterance.feed(frame, p)
        if result is None:
            return
        kind, pcm = result
        if kind == "timeout":
            if self.utterance.followup:   # leave the last reply on the bar a little longer
                self.go_idle(self.utterance.text, TEXT_HOLD_S)
            else:
                self.say(DIDNT_HEAR, lambda _: self.go_idle())
            return
        self.set_state(THINKING, "")
        self.job = (self.generation, self.worker.submit(self.think, pcm))

    def think(self, pcm):
        """Worker thread: transcribe, ask Claude, render the voice. Returns (reply, next step, pcm)."""
        heard = self.stt(pcm)
        if not heard:
            return DIDNT_CATCH, "idle", None
        if is_stop(heard):
            return OKAY, "idle", None
        self.emit("state", state=THINKING, text=f"“{heard}”", hold=0.0)
        reply = self.claude.ask(heard)
        if reply is None:
            return None
        reply = speakable(reply)
        pcm = self.speaker.synth(reply) if self.settings["voice_replies"] else None
        return reply, "followup", pcm

    def on_thinking(self, frame, p):
        generation, future = self.job
        if not future.done():
            return
        self.job = None
        result = future.result() if generation == self.generation else None
        if result is None:
            return self.go_idle()
        reply, step, pcm = result
        if step == "idle":
            self.say(reply, lambda _: self.go_idle())
        else:   # after an answer, keep the reply on screen and listen briefly for a follow-up
            self.say(reply, lambda text: self.listen(FOLLOWUP_LISTEN_S, followup=True, text=text), pcm)

    def on_speaking(self, frame, p):
        if not self.speaker.busy:
            then, self.after_speaking = self.after_speaking, None
            then()


# --- entry point --------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--say", help="speak this text and exit")
    ap.add_argument("--debug", action="store_true", help="log everything the wake engine hears, save samples")
    ap.add_argument("--collect", action="store_true", help="never reply: beep on a wake, save every sample")
    args = ap.parse_args()
    args.debug = args.debug or args.collect

    os.makedirs(DATA_DIR, exist_ok=True)
    handlers = [logging.FileHandler(os.path.join(DATA_DIR, "yo_claude.log"), encoding="utf-8")]
    if sys.stdout:
        handlers.append(logging.StreamHandler(sys.stdout))
    logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(message)s", handlers=handlers)
    log.setLevel(logging.DEBUG if args.debug else logging.INFO)

    if args.say:
        speaker = Speaker()
        pcm = speaker.synth(args.say)
        if pcm is not None:
            speaker.play(pcm)
            time.sleep(len(pcm) / TTS_RATE + 0.2)
        return

    import win32api, win32event, winerror
    mutex = win32event.CreateMutex(None, False, "Local\\YoClaude")
    if win32api.GetLastError() == winerror.ERROR_ALREADY_EXISTS:
        log.info("Already running.")
        return

    import overlay
    settings = Settings()
    events, commands = queue.Queue(), queue.Queue()

    def engine():
        try:
            Assistant(settings, lambda kind, **d: events.put((kind, d)), commands, save_samples=args.debug,
                      collect=args.collect).run()
        except Exception:
            log.exception("Assistant failed to start")
            events.put(("state", {"state": "error", "text": "Couldn't start. See the log (tray menu)."}))

    threading.Thread(target=engine, daemon=True).start()
    overlay.run(settings, events, commands, log_path=os.path.join(DATA_DIR, "yo_claude.log"))
    del mutex


if __name__ == "__main__":
    main()
