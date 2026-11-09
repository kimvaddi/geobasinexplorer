/* Voice for the copilot.
   Spoken replies use the browser's speech synthesis and only pick voices that run on this computer (localService),
   so talking back keeps the file offline. Voice input uses the browser's speech recognition, which in Chrome and Edge
   sends audio to an online service; the copilot keeps it off until the user turns it on. */

interface RecAlternative { transcript: string }
type RecResult = ArrayLike<RecAlternative> & { isFinal: boolean };
interface RecEvent { resultIndex: number; results: ArrayLike<RecResult> }
interface Recognition {
  lang: string; interimResults: boolean; continuous: boolean; maxAlternatives: number;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: RecEvent) => void) | null; onerror: ((e: { error?: string }) => void) | null; onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;
interface VoiceWindow { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor; speechSynthesis?: SpeechSynthesis }

const win = (): VoiceWindow | undefined => (typeof window === "undefined" ? undefined : (window as unknown as VoiceWindow));
const recognitionCtor = () => win()?.SpeechRecognition ?? win()?.webkitSpeechRecognition;

export const canSpeak = () => !!win()?.speechSynthesis && typeof SpeechSynthesisUtterance !== "undefined";
export const canListen = () => !!recognitionCtor();

/* Prefer an Australian English voice to match the data, then other English voices; never a network voice. */
export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const local = voices.filter((v) => v.localService);
  for (const re of [/^en[-_]AU/i, /^en[-_]GB/i, /^en[-_]US/i, /^en/i]) {
    const v = local.find((x) => re.test(x.lang));
    if (v) return v;
  }
  return local[0] ?? null;
}

function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const now = synth.getVoices();
  if (now.length) return Promise.resolve(now);
  return new Promise((resolve) => {
    const done = () => { synth.removeEventListener?.("voiceschanged", done); window.clearTimeout(timer); resolve(synth.getVoices()); };
    const timer = window.setTimeout(done, 1200);
    synth.addEventListener?.("voiceschanged", done);
  });
}

const BEARING: Record<string, string> = { N: "north", S: "south", E: "east", W: "west" };

export function cleanForSpeech(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/\s[·|]\s/g, ", ")
    .replace(/\bpp\. ?(\d)/g, "pages $1")
    .replace(/\bp\. ?(\d)/g, "page $1")
    .replace(/\bs\.d\./g, "standard deviation")
    .replace(/\b([NS])(\d{1,3})°([EW])\b/g, (_, a: string, n: string, b: string) => `${BEARING[a]} ${n} degrees ${BEARING[b]}`)
    .replace(/(\d)\s?km²/g, "$1 square kilometres")
    .replace(/(\d)\s?km\b/g, "$1 kilometres")
    .replace(/(\d)\s?m\b/g, "$1 metres")
    .replace(/(\d)\s?ft\b/g, "$1 feet")
    .replace(/\bSHmax\b/g, "S H max")
    .replace(/(\d)\s?Ma\b/g, "$1 million years")
    .replace(/\s?°/g, " degrees")
    .replace(/[–—]/g, " to ")
    .replace(/\s+/g, " ")
    .trim();
}

let current: SpeechSynthesisUtterance | null = null;
let generation = 0;

/* Speaks the text with an on-device voice. Returns false when the browser cannot speak offline or a newer
   request (or stopSpeaking) superseded this one while voices were loading. */
export async function speak(text: string, on: { onEnd?: () => void; onError?: (code: string) => void } = {}): Promise<boolean> {
  const synth = win()?.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") { on.onError?.("unsupported"); return false; }
  const mine = ++generation;
  const voices = await loadVoices(synth);
  if (mine !== generation) { on.onEnd?.(); return false; }
  /* No on-device voice (or the list never loaded): stay silent rather than let the browser pick an online voice. */
  const voice = pickVoice(voices.length ? voices : synth.getVoices());
  if (!voice) { on.onError?.("no-local-voice"); return false; }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(cleanForSpeech(text).slice(0, 1400));
  u.voice = voice; u.lang = voice.lang;
  u.onend = () => { if (current === u) current = null; on.onEnd?.(); };
  u.onerror = (e) => {
    if (current === u) current = null;
    const code = (e as SpeechSynthesisErrorEvent).error;
    if (code === "interrupted" || code === "canceled") on.onEnd?.(); else on.onError?.(code || "error");
  };
  current = u;
  synth.speak(u);
  return true;
}

export function stopSpeaking() {
  generation++;
  current = null;
  try { win()?.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

/* stop() lets the browser deliver what it already heard; abort() discards it (used when the panel closes). */
export interface Listening { stop(): void; abort(): void }

/* Starts one spoken question. Interim words stream to onInterim; the final transcript goes to onFinal once. */
export function listen(on: { onInterim: (t: string) => void; onFinal: (t: string) => void; onError: (code: string) => void; onEnd: () => void }): Listening | null {
  const Ctor = recognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
  rec.interimResults = true;
  rec.continuous = false;
  rec.maxAlternatives = 1;
  let finalText = "";
  let sent = false;
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const t = r[0]?.transcript ?? "";
      if (r.isFinal) finalText += t; else interim += t;
    }
    if (interim) on.onInterim(`${finalText}${interim}`.trim());
    if (finalText.trim() && !sent) { sent = true; on.onFinal(finalText.trim()); }
  };
  rec.onerror = (e) => on.onError(e.error || "error");
  rec.onend = () => on.onEnd();
  try { rec.start(); } catch { on.onError("start-failed"); return null; }
  return { stop: () => { try { rec.stop(); } catch { /* ignore */ } }, abort: () => { try { rec.abort(); } catch { /* ignore */ } } };
}

export function voiceMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed": return "Microphone access is blocked. Allow it for this file in the browser, or type your question.";
    case "network": return "Voice input needs a network connection, and the speech service could not be reached. You can type instead.";
    case "no-speech": return "I didn't hear a question. Press the microphone and try again.";
    case "audio-capture": return "No microphone was found. You can type your question instead.";
    case "no-local-voice": return "No voice is installed on this computer, so replies are not read aloud. That keeps this file offline.";
    case "unsupported": return "This browser cannot speak replies.";
    default: return "Voice stopped. You can type your question instead.";
  }
}
