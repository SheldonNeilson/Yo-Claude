"""Yo Claude's voice engine: wake word, speech detection, transcription, the voice, and the conversation loop.

Say "yo claude" (or click the bar / tray icon), Claude greets you, you speak, the speech is transcribed locally
(faster-whisper) and sent to the app's active Claude session (sessions.py), and the answer is read aloud in a
Microsoft neural voice (edge-tts). Raw audio never leaves the PC; only the transcribed text goes to Claude.
app.py runs it. Everything it writes lives in ~/.yoclaude (settings.json, yo_claude.log, models).
"""

import asyncio
import difflib
import io
import json
import logging
import os
import queue
import random
import re
import threading
import time
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
WAKE_PHRASES = {"male": "yo claude", "professor": "yo claude", "male3": "yo claude",
                "female": "yo claudia", "female2": "yo claudia", "female3": "yo claudia"}   # (its name)


def wake_phrase(settings):
    return WAKE_PHRASES.get(settings.get("character") or "male", WAKE_PHRASE)
VOSK_MODEL = os.path.join(DATA_DIR, "models", "vosk-model-small-en-us-0.15")
WHISPER_MODEL = "small.en"   # standard speech recognition
# "More accurate speech recognition": bigger and ~2x slower (1.5 GB). On clear speech small.en did as well in tests;
# the bigger model is for mumbled speech, accents and noisy rooms. (distil-large-v3 was slower still, no better.)
ACCURATE_MODEL = "medium.en"
VOICE_TURN_TIMEOUT_S = 1800  # coding tasks can take a while
TIDY_TIMEOUT_S = 8            # fixing what was heard (a Haiku call, usually 3-5 s): after this it's sent as heard
CONVERSATION_WINDOW_S = 300  # a voice conversation older than this starts a new session (unless picked in the app)
FOLLOWUP_LISTEN_S = 6        # after answering, listen this long for a follow-up without the wake word
APPROVAL_LISTEN_S = 8
SPEECH_START_TIMEOUT_S = 7
END_SILENCE_S = 1.5          # pause that ends your request
MAX_UTTERANCE_S = 30
VAD_ON, VAD_OFF = 0.5, 0.35  # Silero speech probability thresholds
NEURAL_VOICE = "en-US-AvaNeural"   # `edge-tts --list-voices` for others
# each character's voice: (voice, pitch). Claudia (female) is Ava; Claude (male, the default) a deep, steady voice
VOICES = {"female": (NEURAL_VOICE, "+0Hz"), "male": ("en-US-ChristopherNeural", "-6Hz"),
          "professor": ("en-GB-RyanNeural", "-3Hz"),    # Male 2: a British voice for the European professor
          "male3": ("en-SG-WayneNeural", "-2Hz"),       # Male 3 (Asian): Singapore English
          "female2": ("en-ZA-LeahNeural", "+0Hz"),      # Female 2 (African): South African English
          "female3": ("en-SG-LunaNeural", "+0Hz")}      # Female 3 (Asian): Singapore English
NEURAL_RATE = "+5%"
TEXT_HOLD_S = 12             # how long a reply stays on the bar when voice replies are off

DEFAULT_SETTINGS = {"listening": True, "voice_replies": True, "pc_control": True, "bar_when_idle": True,
                    "launch_at_login": True, "show_bar": True, "show_window": True, "onboarded": False,
                    "accurate_speech": False}

GREETINGS = ["Yeah?", "Yo!", "Go ahead.", "What's up?", "Mm-hm?"]   # short: you can start talking sooner
PREROLL_S = 1.0      # audio kept from before speech is detected (soft first words)
START_ON = 0.4       # speech probability that starts a request (a little more sensitive than the wake word's)
TARGET_RMS = 3000    # quiet requests are brought up to about this loudness before transcribing
DIDNT_HEAR = "I didn't hear anything."
DIDNT_CATCH = "Sorry, I didn't catch that."
OKAY = "Okay."
STOP_PHRASES = {"never mind", "nevermind", "cancel", "stop", "nothing", "no thanks", "thats all", "goodbye", "bye"}

SAMPLE_RATE = 16000
FRAME_LENGTH = 512
FPS = SAMPLE_RATE / FRAME_LENGTH
TTS_RATE = 24000
IDLE, PAUSED, LISTENING, THINKING, SPEAKING = "idle", "paused", "listening", "thinking", "speaking"
MIC_LOST = "error"   # the only error state left: everything else recovers on its own

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

    DECOYS = ["yo", "you", "your", "close", "closed", "cloud", "claudia", "claude", "clod", "clause", "claws", "loud", "go",
              "load", "though", "hello", "what", "the", "a", "it", "is", "to", "glad", "called"]

    def __init__(self, phrase=WAKE_PHRASE, alternates=()):
        import vosk
        vosk.SetLogLevel(-1)
        self.model = vosk.Model(VOSK_MODEL)
        self.phrase = phrase
        self.speech = self.quiet = 0
        self.last_text = None   # text of the utterance that just finished, if one did on this frame
        self.after = []         # words straight after the wake word in that utterance
        self.set_alternates(alternates)

    def set_alternates(self, alternates):
        """Extra phrases that count as the wake word for this person (from training: how they say it)."""
        import vosk
        self.alternates = list(alternates)
        self.phrases = [self.phrase] + [a for a in alternates if a and a != self.phrase]
        words = {w for p in self.phrases for w in p.split()}
        grammar = self.phrases + [d for d in self.DECOYS if d not in words or d in self.phrase.split()] + ["[unk]"]
        self.rec = vosk.KaldiRecognizer(self.model, SAMPLE_RATE, json.dumps(grammar))

    def set_phrase(self, phrase):
        """Another character picked: their name is the wake word now (the other name is a decoy)."""
        if phrase != self.phrase:
            self.phrase = phrase
            self.set_alternates(self.alternates)

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
        for p in self.phrases:
            if p in text:
                self.after = text.split(p, 1)[1].split()   # words said straight after the wake word
                return True
        return False

    def reset(self):
        self.rec.Reset()
        self.speech = self.quiet = 0


class Utterance:
    """Collects one spoken request: starts when the VAD hears speech, ends after END_SILENCE_S of non-speech.
    It keeps a second from before speech was detected, so a soft first word isn't clipped."""

    def __init__(self, start_timeout_s, followup):
        self.start_timeout_s, self.followup = start_timeout_s, followup
        self.pre = deque(maxlen=int(FPS * PREROLL_S))
        self.audio, self.on, self.off, self.waited = [], 0, 0, 0
        self.strip_wake = False   # began with the wake word ("yo claude, what's ...") in the same breath

    def feed(self, frame, p):
        """None while still listening, ("timeout", None) if nobody spoke, ("done", pcm) when finished."""
        if not self.audio:
            self.pre.append(frame)
            self.on = self.on + 1 if p > START_ON else 0
            if self.on >= 2:
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
    def __init__(self, name=WHISPER_MODEL, download=True):
        """download=False: only if it's already on this PC (raises otherwise)."""
        from faster_whisper import WhisperModel
        t = time.time()
        self.name = name
        try:   # no network check on every start once the model is downloaded
            self.model = WhisperModel(name, device="cpu", compute_type="int8", local_files_only=True)
        except Exception:
            if not download:
                raise
            self.model = WhisperModel(name, device="cpu", compute_type="int8")
        list(self.model.transcribe(np.zeros(SAMPLE_RATE, np.float32), language="en")[0])   # first run is ~5x slower
        log.info("Whisper %s loaded in %.1fs", name, time.time() - t)

    def __call__(self, pcm):
        # Tested on real recordings: beam search dropped first words and a priming prompt made Whisper invent
        # sentences, so it's greedy decoding with no prompt; only the quiet-speech boost helps.
        t = time.time()
        audio = pcm.astype(np.float32) / 32768.0
        frames = [rms(pcm[i:i + FRAME_LENGTH]) for i in range(0, len(pcm) - FRAME_LENGTH, FRAME_LENGTH)] or [1]
        loud = float(np.percentile(frames, 90))
        if 0 < loud < TARGET_RMS:   # quiet speech: bring it up (at most 8x) so it's recognised as well as loud
            audio = np.clip(audio * min(8.0, TARGET_RMS / loud), -1, 1)
        segments, _ = self.model.transcribe(audio, language="en", beam_size=1, condition_on_previous_text=False)
        text = " ".join(s.text.strip() for s in segments if s.no_speech_prob < 0.6).strip()
        log.info("Heard (%.1fs): %r", time.time() - t, text)
        return text


def strip_wake_words(text, alternates=()):
    """ "Yo Claude, what's the weather" -> "what's the weather" (however the wake words were transcribed)."""
    names = "|".join(["claudia", "claude", "cloud", "clod", "claud", "clawed", "clyde", "clode", "clued"] +
                     [re.escape(a.split()[-1]) for a in alternates if a])
    return re.sub(rf"^\W*(?:(?:hey|okay|ok)\W+)?(?:yo|yeah|you|your|yoh|yow|hello)?\W*(?:{names})\b\W*", "", text,
                  count=1, flags=re.I).strip()


# --- audio out ----------------------------------------------------------------
def neural_tts(text, voice=NEURAL_VOICE, rate=TTS_RATE, pitch="+0Hz"):
    """Microsoft neural voice (online) -> mono int16 PCM at `rate`."""
    import av
    import edge_tts

    async def fetch():
        mp3 = bytearray()
        async for chunk in edge_tts.Communicate(text, voice, rate=NEURAL_RATE, pitch=pitch).stream():
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

    def __init__(self, settings=None):
        self.settings = settings if settings is not None else {}
        self.cache = {}
        self.pcm = None
        self.started = self.until = 0.0
        self.n = 0

    def voice(self):
        """The voice of the character picked in Options (Claude: male, the default; Claudia: female)."""
        return VOICES.get(self.settings.get("character") or "male", VOICES["male"])

    def synth(self, text):
        voice, pitch = self.voice()
        if (voice, text) in self.cache:
            return self.cache[(voice, text)]
        for attempt in range(3):
            try:
                return neural_tts(text, voice, pitch=pitch)
            except Exception as e:
                log.warning("Voice attempt %d failed: %s", attempt + 1, e)
                time.sleep(0.3)
        return None

    def warm(self, phrases):
        for p in phrases:
            pcm = self.synth(p)
            if pcm is not None:
                self.cache[(self.voice()[0], p)] = pcm

    def play(self, pcm):
        self.n += 1
        path = os.path.join(DATA_DIR, f"speech-{self.n % 3}.wav")
        write_wav(path, pcm, TTS_RATE)
        winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC | winsound.SND_NODEFAULT)
        self.pcm, self.started = pcm, time.time()
        self.until = self.started + len(pcm) / TTS_RATE + 0.15

    def ended(self):
        """When the sound of what she's saying ends (busy stays true a little longer, for the device to finish)."""
        return self.until - 0.15

    @property
    def busy(self):
        return time.time() < self.until

    def envelope(self, step):
        """The loudness of what's playing, every `step` seconds: the face syncs her mouth to it on her own clock."""
        n = int(TTS_RATE * step)
        return [round(rms(self.pcm[i:i + n])) for i in range(0, len(self.pcm), n)] if self.pcm is not None else []

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


# --- the assistant ------------------------------------------------------------
def is_stop(text):
    return re.sub(r"[^a-z ]", "", text.lower()).strip() in STOP_PHRASES


def approval_verdict(text):
    """True for an explicit go-ahead, False for a no, None if it's unclear (then the click decides)."""
    t = re.sub(r"[^a-z ]", " ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    if re.search(r"\b(go ahead|do it|approve|approved|proceed|allow it|yes please)\b", t):
        return True
    if re.search(r"\b(no|nope|don t|do not|deny|stop|cancel|never mind|wait)\b", t):
        return False
    return None


def voice_command(text):
    """("new", folder?) / ("switch", name) for app commands said out loud, else None."""
    t = re.sub(r"[^a-z0-9 ]", " ", text.lower()).strip()
    t = re.sub(r"\s+", " ", t)
    if re.fullmatch(r"(please )?(start |open |make )?(a )?(new|fresh) (chat|conversation)( please)?", t):
        return ("new", None)
    if re.fullmatch(r"(please )?(start |open |make )?(a )?(new|fresh) session( please)?|start over", t):
        return ("new", "current")
    m = re.fullmatch(r"(switch|go|change) (back )?to (the )?(.+?)( session| chat)?", t)
    if m:
        return ("switch", m.group(4))
    return None


def spoken_part(text):
    """What to read aloud: the plain opening of the reply; the rest stays on screen."""
    head = re.split(r"\n\s*\n|```|\n\s*[-*#|]|\n\s*\d+\.", text.strip(), maxsplit=1)[0]
    head = speakable(head)
    sentences = re.split(r"(?<=[.!?])\s+", head)
    spoken = " ".join(sentences[:3])
    if len(spoken) > 420:
        spoken = spoken[:420].rsplit(" ", 1)[0] + "…"
    if len(speakable(text)) > len(spoken) + 40:
        spoken += " The rest is on screen."
    return spoken or "Done. It's on screen."


class Assistant:
    """Runs on its own thread: reads the mic continuously and moves between idle/listening/thinking/speaking.

    `emit(kind, **data)` reports to the UI ("state", "level"); `commands` takes "talk", "stop", "settings", "quit",
    and ("approval", session, id, summary) from the router when Claude asks permission during a voice turn.
    """

    def __init__(self, settings, emit, commands, router, save_samples=False, collect=False):
        self.settings, self.emit, self.commands, self.router = settings, emit, commands, router
        self.save_samples = save_samples or collect
        self.collect = collect   # --collect: only judge and save what it hears, never reply
        self.hits = self.tries = 0
        self.recent = deque(maxlen=int(FPS * 6))
        self.tail = deque(maxlen=int(FPS * 1))   # mic frames while she speaks: the last second of them
        self.heard_speech = False
        self.emit("state", state="starting", text="")
        self.mic = Mic()
        self.vad = Vad()
        self.wake = VoskWake(phrase=wake_phrase(settings), alternates=settings.get("wake_alternates", []))
        self.training = False        # training mode: report every judgement, never reply
        self.train_mute_until = 0.0
        self.peak = 0.0              # loudest frame of the speech being judged
        self.noise = deque(maxlen=int(FPS * 5))
        self.stt = None
        if settings.get("accurate_speech"):
            try:
                self.stt = Transcriber(ACCURATE_MODEL, download=False)
            except Exception:   # not downloaded yet: start with the standard one, fetch it in the background
                threading.Thread(target=self.switch_speech, args=(True,), daemon=True).start()
        self.stt = self.stt or Transcriber()
        self.speaker = Speaker(settings)
        self.worker = ThreadPoolExecutor(6)   # Claude turns (one per queued voice request) and approvals meanwhile
        self.job = self.utterance = None
        self.backlog = []            # voice requests queued while Claude was answering one: (generation, future), in order
        self.announcements = []      # short "it's done" lines waiting until the voice is free
        self.approval = None         # (session, id, summary) being asked about by voice
        self.approval_job = None
        self.generation = 0          # bumps on stop, so a cancelled job's late result is ignored
        self.after_speaking = None
        self.state = None
        self.quit = False
        router.on_voice_approval = lambda sid, aid, summary: commands.put(("approval", sid, aid, summary))
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
        if self.announcements and self.settings["voice_replies"]:   # a session finished meanwhile: say so now
            line = self.announcements.pop(0)
            return self.say(line, lambda _: self.go_idle(line, TEXT_HOLD_S))
        if self.backlog:   # a request you queued by voice is next: wait for its reply instead of going idle
            self.job = self.backlog.pop(0)
            return self.set_state(THINKING, text, hold)
        self.wake.reset()
        self.set_state(IDLE if self.settings["listening"] else PAUSED, text, hold)

    def listen(self, timeout_s=SPEECH_START_TIMEOUT_S, followup=False, text="", approval=False):
        self.vad.reset()
        self.utterance = Utterance(timeout_s, followup)
        # what the mic heard since her voice actually stopped (the speaker waits a moment longer before listening):
        # you may already have started talking, so it goes in front of what comes next
        ended = self.speaker.ended()
        for t, frame in self.tail:
            if t > ended:
                self.utterance.pre.append(frame)
        self.tail.clear()
        self.utterance.text = text
        self.utterance.approval = approval
        self.set_state(LISTENING, text)

    def say(self, text, then, pcm=None):
        """Speak `text` (or just show it when voice replies are off / the voice is unavailable), then call `then`."""
        if self.settings["voice_replies"] and pcm is None:
            pcm = self.speaker.synth(text)
        if self.settings["voice_replies"] and pcm is not None:
            self.speaker.play(pcm)
            self.emit("speech", started=self.speaker.started, step=0.03, env=self.speaker.envelope(0.03))
            self.after_speaking = lambda: then(text)
            self.set_state(SPEAKING, text)
        else:
            then(text)

    def start_conversation(self):
        """After "yo claude": a beep and straight to listening (you can talk at once, nothing's missed); or, with
        Voice > Say hello after the wake word, a spoken greeting first (what you say while it plays is lost)."""
        self.mic.start()
        if self.settings.get("greeting", False):
            self.say(random.choice(GREETINGS), lambda _: self.listen())
        else:
            winsound.MessageBeep(winsound.MB_OK)
            self.listen()

    def stop(self):
        self.generation += 1
        self.router.interrupt()
        self.speaker.stop()
        self.job = self.approval = self.approval_job = None
        self.go_idle()

    # main loop
    def run(self):
        failures = 0
        try:
            while not self.quit:
                self.handle_commands()
                if self.state in (PAUSED, MIC_LOST):
                    if self.state == MIC_LOST:
                        self.recover_mic()
                    else:
                        self.mic.stop()
                        time.sleep(0.05)
                    continue
                try:
                    self.mic.start()
                    frame = self.mic.read()
                except Exception as e:   # unplugged, asleep, or another app took it: wait and retry
                    log.warning("Microphone failed: %s", e)
                    self.mic_lost()
                    continue
                try:
                    p = self.vad(frame)
                    level = self.speaker.level() if self.state == SPEAKING else rms(frame)
                    self.emit("level", level=level, speech=p > VAD_ON)
                    getattr(self, "on_" + self.state)(frame, p)
                    failures = 0
                except Exception:
                    failures += 1
                    log.exception("Voice engine error (%d in a row)", failures)
                    self.reset_voice()
                    time.sleep(min(5, 0.2 * failures))
        finally:
            self.speaker.stop()
            try:
                self.mic.stop()
            except Exception:
                pass

    def switch_speech(self, accurate):
        """Swap the speech model while running: the current one keeps working until the new one is loaded
        (the accurate one downloads about 1.5 GB the first time)."""
        name = ACCURATE_MODEL if accurate else WHISPER_MODEL
        if self.stt is not None and self.stt.name == name:
            return
        if accurate:
            try:
                new = Transcriber(name, download=False)
            except Exception:
                self.emit("notice", text="Downloading the more accurate speech model (about 1.5 GB, first time "
                                         "only). The standard one keeps working meanwhile.")
                try:
                    new = Transcriber(name)
                except Exception as e:
                    log.warning("Couldn't load %s: %s", name, e)
                    self.emit("notice", text=f"Couldn't get the more accurate speech model: {e}")
                    return
        else:
            new = Transcriber(name)
        self.stt = new
        self.emit("notice", text="More accurate speech recognition is on." if accurate
                  else "Standard speech recognition is on.")

    def reset_voice(self):
        """Drop the voice conversation (not Claude's work: a reply still lands in the window)."""
        self.generation += 1
        self.speaker.stop()
        self.job = self.approval = self.approval_job = self.utterance = None
        self.backlog = []
        self.go_idle()

    def mic_lost(self):
        self.reset_voice()
        self.set_state(MIC_LOST, "Microphone unavailable. Retrying… (check it's plugged in and not in use)")
        self.mic_retry_at = time.time() + 3

    def recover_mic(self):
        """Every few seconds, reopen the default microphone (it may have come back as a different device)."""
        if time.time() < getattr(self, "mic_retry_at", 0):
            time.sleep(0.1)
            return
        try:
            try:
                self.mic.rec.delete()
            except Exception:
                pass
            self.mic = Mic()
            self.mic.start()
            log.info("Microphone back")
            self.vad.reset()
            self.go_idle()
        except Exception as e:
            log.debug("Microphone still unavailable: %s", e)
            self.mic_retry_at = time.time() + 3

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
            elif cmd == "settings":
                if getattr(self, "wake", None):   # (the character may have changed: its name wakes it)
                    self.wake.set_phrase(wake_phrase(self.settings))
                if self.state in (IDLE, PAUSED):
                    self.go_idle()
            elif isinstance(cmd, tuple) and cmd[0] == "train":
                self.training = cmd[1]
                if self.training:
                    self.stop()
                    self.mic.start()
                    self.set_state(IDLE, "Training: listening to how you say it", hold=3600)
                else:
                    self.go_idle()
            elif isinstance(cmd, tuple) and cmd[0] == "announce":
                self.announcements.append(cmd[1])
                if self.state in (IDLE, PAUSED):   # free now; otherwise it waits until the voice is
                    self.go_idle()
            elif isinstance(cmd, tuple) and cmd[0] == "ack":   # a spoken request is taking a while: say so, then back to waiting
                if (self.job is not None and self.state == THINKING and self.approval is None and self.approval_job is None
                        and self.settings["voice_replies"]):
                    self.say(cmd[1], lambda _: self.set_state(THINKING))
            elif isinstance(cmd, tuple) and cmd[0] == "alternates":
                self.wake.set_alternates(cmd[1])
            elif isinstance(cmd, tuple) and cmd[0] == "accurate_speech":
                threading.Thread(target=self.switch_speech, args=(cmd[1],), daemon=True).start()
            elif isinstance(cmd, tuple) and cmd[0] == "approval" and self.job and self.state == THINKING:
                self.approval = cmd[1:]
                self.say(f"Claude wants to {cmd[3]}. Say yes, go ahead, or no.",
                         lambda _: self.listen(APPROVAL_LISTEN_S, approval=True))

    def on_idle(self, frame, p):
        self.recent.append(frame)
        level = rms(frame)
        if p > VAD_ON:
            self.peak = max(self.peak, level)
        else:
            self.noise.append(level)
        self.heard_speech = self.heard_speech or p > VAD_ON
        woke = self.wake.feed(frame, p)
        if self.training and self.wake.last_text is not None and self.heard_speech:
            # skip our own beep (heard right after a wake) and sounds that weren't words at all
            if self.wake.last_text and time.time() > self.train_mute_until:
                noise = float(np.percentile(self.noise, 50)) if self.noise else 0.0
                log.info("Training: heard %r, woke=%s, voice %d, room %d", self.wake.last_text, bool(woke),
                         self.peak, noise)
                self.emit("train", heard=self.wake.last_text, woke=bool(woke), peak=self.peak, noise=noise)
                if woke:
                    winsound.MessageBeep(winsound.MB_OK)
                    self.train_mute_until = time.time() + 1.2
            self.heard_speech, self.peak = False, 0.0
            return
        if self.wake.last_text is not None:
            self.peak = 0.0
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
        elif woke and self.wake.after:
            # "yo claude, what's the weather...": you kept talking, so no greeting; keep recording to the pause
            log.info("Wake word heard, with a request in the same breath")
            self.mic.start()
            self.listen()
            self.utterance.audio = list(self.recent)
            self.utterance.strip_wake = True
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
        if self.utterance.approval:
            if kind == "timeout":
                self.say("Okay, it's waiting for you on screen.", lambda _: self.set_state(THINKING))
            else:
                self.approval_job = self.worker.submit(self.stt, pcm)
                self.set_state(THINKING)
            return
        if kind == "timeout":
            if self.utterance.followup:   # leave the last reply on the bar a little longer
                self.go_idle(self.utterance.text, TEXT_HOLD_S)
            else:
                self.say(DIDNT_HEAR, lambda _: self.go_idle())
            return
        self.set_state(THINKING, "")
        self.wake.reset(); self.recent.clear()   # listening for "yo claude" again meanwhile (to queue): start clean
        self.job = (self.generation, self.worker.submit(self.think, pcm, self.generation, self.utterance.strip_wake))
        if self.backlog:   # queued behind the reply(s) still coming: answered in the order you asked
            self.backlog.append(self.job)
            self.job = self.backlog.pop(0)

    def think(self, pcm, generation, strip_wake=False):
        """Worker thread: transcribe, run voice commands or ask Claude, render the voice.
        Returns (reply, next step, pcm)."""
        heard = self.stt(pcm)
        if strip_wake:
            heard = strip_wake_words(heard, self.settings.get("wake_alternates", []))
            if len(heard.split()) < 2:   # it was only the wake word after all: greet and listen as usual
                return None, "greet", None
        if not heard:
            return DIDNT_CATCH, "idle", None
        if is_stop(heard):
            return OKAY, "idle", None
        command = voice_command(heard)
        if command:
            return self.run_command(command), "followup", None
        self.emit("state", state=THINKING, text=f"“{heard}”", hold=0.0)
        s = self.router.active
        if s is not None and not s.picked and time.time() - s.last_used > CONVERSATION_WINDOW_S:
            self.router.new_session()   # an old voice conversation: start afresh
        sid = self.router.active.id if self.router.active else None
        heard = self.tidy(heard, sid)
        if generation != self.generation:   # "stop" while it was being fixed
            self.emit("dictation", session=sid, stage="sent", text="")
            return None
        try:
            reply = self.router.send(heard, voice=True, sid=sid)
            self.emit("dictation", session=sid, stage="sent", text=heard)   # it's in the chat now: out of the box
            reply = reply.result(VOICE_TURN_TIMEOUT_S)
        except Exception as e:
            log.warning("Voice turn failed: %s", e)
            reply = None
        if generation != self.generation:
            return None
        if not reply:
            return "Sorry, something went wrong. It's on screen.", "idle", None
        spoken = spoken_part(reply)
        pcm = self.speaker.synth(spoken) if self.settings["voice_replies"] else None
        return spoken, "followup", pcm

    def tidy(self, heard, sid):
        """What you said goes into the message box, gets its spelling, grammar and misheard words fixed by Haiku
        (sessions.tidy_text), and is then sent. The fix gets TIDY_TIMEOUT_S at most; after that, or if it fails, what
        was heard goes as it is."""
        if not self.settings.get("fix_text", True):
            return heard
        self.emit("dictation", session=sid, stage="heard", text=heard)
        try:
            fixed = self.router.tidy(heard, sid).result(TIDY_TIMEOUT_S) or heard
        except Exception as e:
            log.info("Couldn't fix what was heard (%s): sending it as it is", e or type(e).__name__)
            fixed = heard
        if fixed != heard:
            self.emit("state", state=THINKING, text=f"“{fixed}”", hold=0.0)
        self.emit("dictation", session=sid, stage="fixed", text=fixed)
        return fixed

    def run_command(self, command):
        if command[0] == "new":
            s = self.router.new_session(command[1])
            return "Okay, new " + ("session in " + os.path.basename(s.cwd) if s.cwd else "chat") + "."
        name = command[1]
        sessions = self.router.list(self.router.folder)
        titles = [x["title"].lower() for x in sessions]
        match = difflib.get_close_matches(name, titles, n=1, cutoff=0.4) or [t for t in titles if name in t][:1]
        if not match:
            return f"I couldn't find a session called {name}."
        target = sessions[titles.index(match[0])]
        self.router.open(target["id"], target["cwd"])
        return f"Switched to {target['title'][:60]}."

    def on_thinking(self, frame, p):
        if self.approval is None and self.approval_job is None and self.job is not None and self.settings["listening"]:
            self.recent.append(frame)
            woke = self.wake.feed(frame, p)
            if woke:   # "yo claude" while Claude works on your last request: queue another one
                log.info("Wake word heard while Claude is working: queueing another request")
                self.backlog.insert(0, self.job)   # the one being answered stays first in line
                self.job = None
                if self.wake.after:   # said in one breath: keep recording to the pause
                    self.listen()
                    self.utterance.audio = list(self.recent)
                    self.utterance.strip_wake = True
                else:
                    self.say("Yes? I'll queue it.", lambda _: self.listen())
                return
        if self.approval_job is not None:
            if not self.approval_job.done():
                return
            heard, self.approval_job = self.approval_job.result(), None
            (sid, aid, _), self.approval = self.approval, None
            verdict = approval_verdict(heard)
            if verdict is None:
                return self.say("I didn't get a clear yes or no, so it's waiting on screen.",
                                lambda _: self.set_state(THINKING))
            self.router.approve(sid, aid, verdict)
            return self.say("Going ahead." if verdict else "Okay, I won't.", lambda _: self.set_state(THINKING))
        if self.job is None:
            return self.go_idle()
        generation, future = self.job
        if not future.done():
            return
        self.job = None
        result = future.result() if generation == self.generation else None
        if result is None:
            return self.go_idle()
        reply, step, pcm = result
        if step == "greet":
            self.start_conversation()
        elif step == "idle":
            self.say(reply, lambda _: self.go_idle())
        elif self.backlog:   # more queued replies to come: straight on to the next, no follow-up pause
            self.say(reply, lambda text: self.go_idle(text, TEXT_HOLD_S), pcm)
        else:   # after an answer, keep the reply on screen and listen briefly for a follow-up
            self.say(reply, lambda text: self.listen(FOLLOWUP_LISTEN_S, followup=True, text=text), pcm)

    def on_speaking(self, frame, p):
        self.tail.append((time.time(), frame))   # (see listen: the start of a quick follow-up)
        if not self.speaker.busy:
            then, self.after_speaking = self.after_speaking, None
            then()
