import { LiveCitationPage } from "./live-page";
import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowUpRight, FileText, FlaskConical, MapPin, MessageSquareText, Mic, Plus, RotateCcw, Square, Volume2, VolumeX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CopilotAvatar } from "@/components/brand";
import { BRAND } from "@brand";
import { Rich } from "@/components/panels/common";
import { shortDoc, type Answer5, type AnswerLabel } from "@/lib/answer5";
import { CLOUD, validationText, type AskProgress, type Me } from "@/lib/cloud";
import type { HDef } from "@/lib/hypothesis";
import { libraryStats } from "@/lib/search";
import { KEYS, usePersistent } from "@/lib/persist";
import { canListen, canSpeak, listen, speak, stopSpeaking, voiceMessage, type Listening } from "@/lib/voice";
import { ResizeHandle } from "@/components/resize-handle";

/* Exploration copilot: the one assistant, docked beside every workspace. Every reply carries its sources or says
   Not found. Offline, replies quote or compute from the public data in this file and no text is generated. In the
   cloud build, prepared answers are computed the same way, other answers are written from retrieved passages, and
   every statement is checked before it is shown; the badge and footer say which applies. The conversation shows
   every answer in the app, wherever it was asked. Replies can be read aloud with an on-device voice; voice input is
   opt-in because the browser's speech recognition is online. */

export interface CopilotContext { workspace: string; place: string; detail: string }
export const COPILOT_TOGGLE_ID = "gbx-copilot-toggle";
interface Meta { at: number; via: "text" | "voice" }

/* Short chip labels for the suggested questions; the full question is what gets asked. */
const SHORT: Record<string, string> = {
  "Which plays are analogs to the Cooper Basin Patchawarra Play?": "Analogs to the Patchawarra Play",
  "Do the Galilee and Bowen basins have same-age counterparts of the Cooper rift plays?": "Same-age plays in Galilee and Bowen",
  "What is the top of the Toolachee Formation in Marabooka 1, below the kelly bushing and below sea level?": "Toolachee top in Marabooka 1",
  "Which source defines the Cooper Basin play intervals, and how many play intervals does it use?": "Cooper play intervals and their source",
  "Which figure in the Cooper Basin data guide shows where the boreholes and seismic surveys are?": "Figure of Cooper boreholes and surveys",
  "Compare the four basins": "Compare the four basins",
  "In the 1960 Innamincka 1 report, what shut-in pressure did DST 10 record, and over which perforations?": "DST 10 pressure in Innamincka 1",
  "What is the porosity of the Hutton Sandstone?": "Hutton Sandstone porosity",
  "How deep is the Taroom Trough?": "Depth of the Taroom Trough",
  "What is the mean maximum horizontal stress (SHmax) direction inside the Cooper Basin, from quality A–C records, and how many records support it?": "Cooper stress direction (SHmax)",
  "Which Galilee boreholes are deepest?": "Deepest Galilee boreholes",
  "Which plays are the same age as the Merrimelia Play?": "Plays the same age as Merrimelia",
  "Does the Marabooka 1 report suggest the Toolachee and Patchawarra could be in communication?": "Toolachee and Patchawarra communication",
  "Which Adavale units are reservoirs?": "Adavale reservoir units",
  "What is the SHmax orientation in the Cooper Basin?": "Cooper Basin stress direction",
  "Tell me about the Toolachee Formation": "About the Toolachee Formation",
  "What was the DST 10 shut-in pressure in Innamincka 1?": "DST 10 pressure in Innamincka 1",
  "How many Galilee boreholes are deeper than 2,000 m?": "Galilee boreholes deeper than 2 km",
  "How old is the North Bowen Basin?": "Age of the North Bowen Basin",
  "What do we know here?": "What we know here",
  "How deep is the basin floor here?": "Basin floor depth here",
  "Which boreholes are nearest?": "Nearest boreholes",
  "What is the source rock in the Cooper Basin?": "Cooper Basin source rocks",
  "Which figure in the Galilee Basin data guide shows where the boreholes and seismic surveys are?": "Figure of Galilee boreholes and surveys",
  "What are the reservoirs in the Galilee Basin?": "Galilee reservoir units",
  "Which plays are analogs to the Aramac Play?": "Analogs to the Aramac Play",
  "Which figure in the North Bowen Basin data guide shows where the boreholes and seismic surveys are?": "Figure of North Bowen boreholes and surveys",
  "Where is the North Bowen Basin floor deepest, and how deep does it get?": "Deepest North Bowen basin floor",
  "Which figure in the Adavale Basin data guide shows where the boreholes and seismic surveys are?": "Figure of Adavale boreholes and surveys",
  "How old is the Adavale Basin?": "Age of the Adavale Basin",
  "Where is the Adavale Basin floor deepest, and how deep does it get?": "Deepest Adavale basin floor",
};
const LABEL_TONE: Record<AnswerLabel, string> = {
  Precomputed: "bg-violet-400/15 text-violet-100 ring-violet-300/40",
  Retrieved: "bg-sky-400/15 text-sky-100 ring-sky-300/40",
  "Not found": "bg-white/10 text-slate-100 ring-white/25",
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const ago = (at: number, now: number) => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 45 ? "Just now" : s < 3600 ? `${Math.max(1, Math.round(s / 60))} min ago` : new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};
const grounding = (a: Answer5) => {
  const n = a.citations.length;
  if (a.label === "Not found" || !n) return a.engine ? "Not found in the library" : "Not found in this file's data";
  if (a.label === "Precomputed") return `Worked out from ${plural(n, "source")}`;
  return a.engine ? `Written from ${plural(n, "source")}` : `Quoted from ${plural(n, "source")}`;
};

/* What the copilot says aloud: the answer itself, then where it came from. */
export function spokenReply(a: Answer5): string {
  const paras: string[] = [];
  let len = 0;
  for (const p of a.paragraphs) { if (len > 420 && paras.length) break; paras.push(p); len += p.length; }
  let s = paras.join(" ");
  if (a.table?.rows.length) s += ` The full answer has a table with ${plural(a.table.rows.length, "row")}.`;
  const cites = a.citations.slice(0, 2).map((c) => `${shortDoc(c.doc)}${c.page ? `, page ${c.page}` : ""}`);
  if (cites.length) s += ` Source${a.citations.length > 1 ? "s" : ""}: ${cites.join("; ")}${a.citations.length > 2 ? `, and ${a.citations.length - 2} more` : ""}.`;
  return s;
}

function IconBtn({ label, onClick, pressed, disabled, live, children }: { label: string; onClick: () => void; pressed?: boolean; disabled?: boolean; live?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}
      className={cn("grid size-8 shrink-0 place-items-center rounded-lg text-slate-300 transition-colors hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-copilot-300 disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4",
        pressed && "bg-white/10 text-copilot-200", live && "bg-rose-500/25 text-rose-50 ring-1 ring-rose-300/60")}>
      {children}
    </button>
  );
}
const chip = "rounded-lg border border-white/15 bg-white/[0.06] px-2.5 py-1.5 text-left text-xs font-medium text-slate-100 transition-colors hover:border-copilot-300/50 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-copilot-300";
const action = "inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/[0.06] px-2 py-1 text-xs font-medium text-slate-100 transition-colors hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-copilot-300 [&_svg]:size-3.5";
function BotMark() {
  return <CopilotAvatar className="mt-0.5 size-8" />;
}

function MiniTable({ t }: { t: NonNullable<Answer5["table"]> }) {
  const rows = t.rows.slice(0, 5);
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-[11.5px]">
        <thead className="bg-white/[0.06]"><tr>{t.columns.map((c) => <th key={c} scope="col" className="px-2 py-1 text-left font-semibold text-slate-100">{c}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-white/10">{r.map((c, j) => <td key={j} className="px-2 py-1 tabular-nums text-slate-200">{c}</td>)}</tr>)}</tbody>
      </table>
      {t.rows.length > rows.length && <p className="border-t border-white/10 px-2 py-1 text-[11px] text-slate-300">{plural(t.rows.length - rows.length, "more row")} in the full answer</p>}
    </div>
  );
}

/* Follow-ups the engine suggests: questions are asked; "Open …" items are actions that open their view.
   Anything else (statements, actions without a target) is dropped so it is never sent to the engine as a question. */
export function followUpsFor(a: Answer5): string[] {
  const ok = (f: string) => /\?$/.test(f) || (/^Open Analogs/.test(f) && !!a.analogRef) || (/^Open .* evidence$/.test(f) && !!a.fieldRef) || /^Open Evidence/.test(f);
  return [...new Set(a.followUps ?? [])].filter(ok).slice(0, 3);
}

function UserMsg({ text, voice }: { text: string; voice: boolean }) {
  return (
    <div data-copilot="user" className="flex justify-end">
      <p className="max-w-[85%] rounded-2xl rounded-br-md border border-copilot-300/25 bg-copilot-300/10 px-3 py-2 text-[13.5px] leading-relaxed text-slate-50">
        <span className="sr-only">{voice ? "You said: " : "You: "}</span>
        {voice && <Mic className="mr-1 inline size-3.5 align-[-2px] text-copilot-200" aria-hidden="true" />}{text}
      </p>
    </div>
  );
}

function Reply({ a, at, now, latest, speaking, canTalk, onTalk, onShow, onOpenFull, onHypothesis, onFollow }: {
  a: Answer5; at: number; now: number; latest: boolean; speaking: boolean; canTalk: boolean; onTalk: () => void; onShow: (a: Answer5) => void;
  onOpenFull: (a: Answer5) => void; onHypothesis: (id: HDef["id"]) => void; onFollow: (f: string, a: Answer5) => void;
}) {
  const [quote, setQuote] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const long = a.paragraphs.length > 2 || a.paragraphs.join(" ").length > 520;
  const paras = more || !long ? a.paragraphs : a.paragraphs.slice(0, 2);
  const cite = quote ? a.citations.find((c) => c.id === quote) : undefined;
  const follow = latest ? followUpsFor(a) : [];
  return (
    <div data-copilot="reply" className="flex gap-2.5">
      <BotMark />
      <div className="min-w-0 flex-1 space-y-2">
        {a.placeNote && <p className="flex items-start gap-1.5 text-[11.5px] leading-snug text-copilot-100"><MapPin className="mt-px size-3.5 shrink-0 text-copilot-200" aria-hidden="true" /><span>{a.placeNote}</span></p>}
        <div className="space-y-1.5 text-[13.5px] leading-relaxed text-slate-100 [&_strong]:text-white">
          <span className="sr-only">Copilot: </span>
          {paras.map((t, i) => <p key={i} className={cn(/^\d+\. /.test(t) && "pl-3")}><Rich text={t} /></p>)}
          {long && <button type="button" aria-expanded={more} onClick={() => setMore(!more)} className="text-xs font-semibold text-copilot-200 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-copilot-300">{more ? "Show less" : "Show more"}</button>}
        </div>
        {a.table && <MiniTable t={a.table} />}
        {a.citations.length > 0 && (
          <div className="space-y-1.5">
            <ul aria-label="Sources" className="flex flex-wrap gap-1.5">
              {a.citations.slice(0, 6).map((c) => (
                <li key={c.id} className="max-w-full">
                  <button type="button" data-copilot="source" aria-expanded={quote === c.id} title={`${c.doc}${c.page ? ` · p. ${c.page}` : ""}`} onClick={() => setQuote(quote === c.id ? null : c.id)}
                    className={cn("flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11.5px] text-slate-100 transition-colors focus-visible:outline-2 focus-visible:outline-copilot-300", quote === c.id ? "border-copilot-300/60 bg-copilot-300/15" : "border-white/15 bg-white/[0.05] hover:bg-white/10")}>
                    <FileText className="size-3 shrink-0 text-copilot-200" aria-hidden="true" />
                    <span className="truncate">{shortDoc(c.doc)}{a.engine === "azure" && c.provenanceLabel ? ` · ${c.provenanceLabel}` : ""}{c.page ? ` · p. ${c.page}` : ""}</span>
                  </button>
                </li>
              ))}
              {a.citations.length > 6 && <li className="self-center text-[11px] text-slate-300">+{a.citations.length - 6} more</li>}
            </ul>
            {cite && (
              <blockquote className="space-y-0.5 rounded-lg border-l-2 border-copilot-300/70 bg-white/[0.05] p-2 text-xs text-slate-200">
                <p className="font-semibold text-slate-100">{cite.heading}</p>
                <p>{cite.text.length > 420 ? `${cite.text.slice(0, 420)}…` : cite.text}</p>
                <LiveCitationPage citation={cite} />
              </blockquote>
            )}
          </div>
        )}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-slate-300">
          <span aria-hidden="true">{ago(at, now)}</span><span className="sr-only">{`At ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`}</span><span aria-hidden="true">·</span><span>{grounding(a)}</span>
          {a.ms != null && <><span aria-hidden="true">·</span><span className="tabular-nums">{a.ms < 1 ? "<1" : Math.round(a.ms)} ms</span></>}
          <span className={cn("rounded px-1.5 py-px font-medium ring-1", LABEL_TONE[a.label])}>{a.label}</span>
        </p>
        {validationText(a) && <p className={cn("text-[11px]", a.validation?.status === "passed" ? "text-copilot-100" : "text-amber-100")}>{validationText(a)}</p>}
        <div className="flex flex-wrap gap-1.5">
          {(a.focus || a.focusBasin) && <button type="button" className={action} onClick={() => onShow(a)}><MapPin aria-hidden="true" /> Show on map</button>}
          {canTalk && <button type="button" className={cn(action, speaking && "border-copilot-300/60 text-copilot-100")} aria-label={speaking ? "Stop reading" : "Read aloud"} onClick={onTalk}>{speaking ? <Square aria-hidden="true" /> : <Volume2 aria-hidden="true" />} {speaking ? "Stop" : "Read aloud"}</button>}
          {a.hypothesisRef && <button type="button" className={action} onClick={() => onHypothesis(a.hypothesisRef!)}><FlaskConical aria-hidden="true" /> Test as a hypothesis</button>}
          <button type="button" className={action} onClick={() => onOpenFull(a)}><MessageSquareText aria-hidden="true" /> Open full answer</button>
        </div>
        {follow.length > 0 && (
          <div className="space-y-1 pt-0.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-300" aria-hidden="true">Ask next</p>
            <ul aria-label="Ask next" className="flex flex-wrap gap-1.5">
              {follow.map((f) => <li key={f}><button type="button" className={chip} onClick={() => onFollow(f, a)}>{SHORT[f] ?? f}</button></li>)}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/* docked: a column beside the workspace (1280 px and up). overlay: over the right of the workspace, below the
   workspace bar (1024 to 1279 px). sheet: a modal sheet with a backdrop on tablets and phones. */
export type CopilotMode = "docked" | "overlay" | "sheet";

/* What the context badge and the footer say about how replies are made in this build, and whether AI is paused. */
function answerMode(s: Me | null | undefined): { badge: string; tone: string; footer: string } {
  const green = "bg-emerald-400/15 text-emerald-200 ring-emerald-300/30";
  if (!CLOUD) return { badge: "Offline", tone: green, footer: "Answers quote or compute from this file's public data. No text is generated." };
  if (s?.ai === false) return { badge: "AI paused", tone: "bg-amber-400/15 text-amber-200 ring-amber-300/30", footer: "AI is paused, so answers quote or compute from the sources without an independent check." };
  if (!s?.models) return { badge: "Cloud", tone: "bg-white/10 text-slate-200 ring-white/20", footer: "Answers cite their sources or say Not found." };
  return { badge: "Azure AI", tone: green, footer: `Answers cite their sources. ${s.models.writer} writes any that aren't prepared, and ${s.models.checker} checks every statement first.` };
}
export function CopilotPanel(p: {
  open: boolean; onOpenChange: (open: boolean) => void; mode: CopilotMode; context: CopilotContext; starters: string[];
  answers: Answer5[]; onClear: () => void;
  onAsk: (q: string) => Promise<Answer5>; onShow: (a: Answer5) => void; onOpenFull: (a: Answer5) => void; onOpenAnswers: () => void;
  onHypothesis: (id: HDef["id"]) => void; onAddDoc: () => void; onAnalogs: (ref: string) => void; onOpenField: (site: string, field: string) => void;
  /* Cloud build only: whether AI is on and which models write and check; null until the service has said. */
  service?: Me | null;
  /* Cloud build only: answers limited to a place on the map, said plainly with a way to stop. */
  scope?: { text: string; onClear: () => void } | null;
  /* Version 2 only: what the Foundry scientists have read so far while their answer is on its way. */
  progress?: AskProgress | null;
  /* Changes when another part of the app hands the conversation over, so the question box takes focus. */
  focusSignal?: number;
  /* Width when docked or over the workspace, and how far its left edge can be dragged; the sheet keeps its own width. */
  size: { width: number; min: number; max: number; onResize: (width: number) => void; onReset: () => void };
}) {
  const [meta, setMeta] = useState<Record<string, Meta>>({});
  const [pending, setPending] = useState<{ text: string; via: "text" | "voice" } | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [speaking, setSpeaking] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [consent, setConsent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [speakReplies, setSpeakReplies] = usePersistent<boolean>(KEYS.copilotVoice, false);
  const [micOk, setMicOk] = usePersistent<boolean>(KEYS.copilotMic, false);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const rec = useRef<Listening | null>(null);
  const wasOpen = useRef(p.open);
  const wasMode = useRef(p.mode);
  const focusInside = useRef(false);
  const openRef = useRef(p.open);
  const busyRef = useRef(false);
  const askRef = useRef<(raw: string, via: "text" | "voice") => void>(() => {});
  const talkOk = canSpeak();
  const micAvailable = canListen();
  const thread = [...p.answers].reverse();

  /* Move focus only when someone opens or closes the copilot. A change of window width also switches between docked
     and overlay, which can open or close it; then focus stays put unless it was inside the copilot when it closed. */
  useEffect(() => {
    openRef.current = p.open;
    const resized = wasMode.current !== p.mode;
    if (p.open && !wasOpen.current && !resized) window.requestAnimationFrame(() => input.current?.focus());
    if (!p.open && wasOpen.current && (!resized || focusInside.current)) window.requestAnimationFrame(() => document.getElementById(COPILOT_TOGGLE_ID)?.focus({ preventScroll: true }));
    if (!p.open) focusInside.current = false;
    wasOpen.current = p.open; wasMode.current = p.mode;
  }, [p.open, p.mode]);
  /* Answers asked anywhere in the app join the conversation; remember when each first appeared. */
  useEffect(() => {
    const fresh = p.answers.filter((a) => !meta[a.id]);
    if (fresh.length) setMeta((m) => { const n = { ...m }; for (const a of fresh) n[a.id] = n[a.id] ?? { at: Date.now(), via: "text" }; return n; });
  }, [p.answers, meta]);
  useEffect(() => { if (!p.open) return; const t = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(t); }, [p.open]);
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; }, [p.answers.length, pending, busy, consent, notice, p.open]);
  useEffect(() => () => { stopSpeaking(); rec.current?.abort(); }, []);
  useEffect(() => { if (p.focusSignal) window.requestAnimationFrame(() => input.current?.focus()); }, [p.focusSignal]);

  const talk = (id: string, a: Answer5) => {
    setSpeaking(id);
    void speak(spokenReply(a), {
      onEnd: () => setSpeaking((s) => (s === id ? null : s)),
      onError: (code) => { setSpeaking((s) => (s === id ? null : s)); setNotice(voiceMessage(code)); },
    });
  };
  const ask = (raw: string, via: "text" | "voice") => {
    const q = raw.trim().slice(0, 300);
    if (!q || busyRef.current) return;
    busyRef.current = true;
    stopSpeaking(); setSpeaking(null); setNotice(null); setText(""); setNow(Date.now());
    setPending({ text: q, via });
    setBusy(true);
    window.setTimeout(async () => {
      let a: Answer5;
      try { a = await p.onAsk(q); } catch { busyRef.current = false; setBusy(false); setPending(null); setNotice("Something went wrong while answering. Try rephrasing the question."); return; }
      const id = a.id;
      setMeta((m) => ({ ...m, [id]: { at: Date.now(), via } }));
      setPending(null);
      busyRef.current = false; setBusy(false);
      if ((via === "voice" || speakReplies) && talkOk && openRef.current) talk(id, a);
    }, 40);
  };
  useEffect(() => { askRef.current = ask; });
  const startListening = () => {
    stopSpeaking(); setSpeaking(null); setNotice(null); setConsent(false);
    const l = listen({
      onInterim: (t) => { if (openRef.current) setText(t); },
      onFinal: (t) => { rec.current = null; setListening(false); if (openRef.current) askRef.current(t, "voice"); },
      onError: (code) => { if (openRef.current) setNotice(voiceMessage(code)); },
      onEnd: () => { rec.current = null; setListening(false); },
    });
    if (l) { rec.current = l; setListening(true); input.current?.focus(); }
  };
  const toggleMic = () => {
    if (listening) { rec.current?.stop(); return; }
    if (!micOk) { setConsent(true); return; }
    startListening();
  };
  const close = () => {
    stopSpeaking(); rec.current?.abort(); rec.current = null;
    setSpeaking(null); setListening(false); setConsent(false);
    p.onOpenChange(false);
  };
  const reset = () => { stopSpeaking(); setSpeaking(null); setNotice(null); p.onClear(); input.current?.focus(); };
  /* Below the large breakpoint the copilot covers what it would reveal, so close it before showing the map or a panel. */
  const handOff = (fn: () => void) => { if (p.mode === "sheet") close(); fn(); };
  const onFollow = (f: string, a: Answer5) => {
    if (/^Open Analogs/.test(f) && a.analogRef) handOff(() => p.onAnalogs(a.analogRef!));
    else if (/^Open .* evidence$/.test(f) && a.fieldRef) handOff(() => p.onOpenField(a.fieldRef!.site, a.fieldRef!.field));
    else if (/^Open Evidence/.test(f)) handOff(() => p.onOpenField("core", ""));
    else if (/\?$/.test(f)) ask(f, "text");
  };
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    if (listening) rec.current?.stop(); else if (consent) setConsent(false); else close();
  };

  if (!p.open) return null;

  const lib = libraryStats();
  const chips = [...new Map(p.starters.map((s) => [SHORT[s] ?? s, s] as const)).entries()].slice(0, 4);
  const sheet = p.mode === "sheet";
  const how = answerMode(p.service);
  return (
    <>
    {sheet && <div className="fixed inset-x-0 bottom-0 top-14 z-40 bg-black/50" aria-hidden="true" onClick={close} />}
    <aside id="gbx-copilot" aria-label="Exploration copilot" role={sheet ? "dialog" : undefined} aria-modal={sheet || undefined} onKeyDown={onKey}
      onFocus={() => { focusInside.current = true; }} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) focusInside.current = false; }}
      style={sheet ? undefined : { width: p.size.width }}
      className={cn("flex flex-col overflow-hidden bg-copilot-surface text-slate-100",
        p.mode === "docked" ? "relative h-full shrink-0 border-l border-white/10"
          : p.mode === "overlay" ? "absolute inset-y-0 right-0 z-40 border-l border-copilot-100/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.65)]"
          : "fixed inset-x-0 bottom-0 top-14 z-50 border-l border-copilot-100/15 shadow-[0_24px_60px_-12px_rgba(0,0,0,0.65)] sm:left-auto sm:w-[400px]")}>
      {!sheet && <ResizeHandle panelId="gbx-copilot" edge="left" label="Resize the copilot" width={p.size.width} min={p.size.min} max={p.size.max}
        onResize={p.size.onResize} onReset={p.size.onReset} lineClassName="group-hover:bg-copilot-300/60 group-focus-visible:bg-copilot-300 group-data-[dragging=true]:bg-copilot-300" />}
      <header className="flex shrink-0 items-start justify-between gap-2 px-4 pb-2 pt-4">
        <div className="flex min-w-0 items-center gap-3">
          <CopilotAvatar className="size-10" />
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-copilot-200">
              <span className="size-2 rounded-full bg-emerald-400 shadow-[0_0_0_3px_rgba(52,211,153,0.18)]" aria-hidden="true" /> GeoBasin AI
            </p>
            <h2 className="mt-1 text-lg font-semibold tracking-tight text-white">Exploration copilot</h2>
            {/* Only the cloud build runs on Foundry; the offline file answers from its own data. */}
            {CLOUD && BRAND.copilot?.builtOn && <p className="mt-0.5 text-xs text-copilot-200" data-gbx-copilot-built-on>{BRAND.copilot.builtOn}</p>}
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {talkOk && <IconBtn label="Speak replies aloud" pressed={speakReplies} onClick={() => { const next = !speakReplies; setSpeakReplies(next); if (!next) { stopSpeaking(); setSpeaking(null); } }}>{speakReplies ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}</IconBtn>}
          <IconBtn label="Start a new conversation" disabled={!p.answers.length} onClick={reset}><RotateCcw aria-hidden="true" /></IconBtn>
          <IconBtn label="Close the copilot" onClick={close}><X aria-hidden="true" /></IconBtn>
        </div>
      </header>

      <section aria-label="Context" className="mx-4 shrink-0 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-300">Context · {p.context.workspace}</p>
          <span className={cn("rounded-full px-1.5 py-px text-[10px] font-semibold ring-1", how.tone)}>{how.badge}</span>
        </div>
        <p className="truncate text-sm font-semibold text-white">{p.context.place}</p>
        <p className="text-xs text-slate-300">{p.context.detail}</p>
        {p.scope && (
          <div className="mt-1.5 flex items-start gap-1.5 rounded-lg bg-copilot-300/10 px-2 py-1 text-[11px] leading-snug text-copilot-50 ring-1 ring-copilot-200/30">
            <MapPin className="mt-px size-3.5 shrink-0 text-copilot-200" aria-hidden="true" />
            <p className="min-w-0 flex-1">{p.scope.text}</p>
            <button type="button" aria-label="Stop limiting answers to this place" onClick={p.scope.onClear}
              className="grid size-5 shrink-0 place-items-center rounded text-copilot-100 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-copilot-200"><X className="size-3.5" aria-hidden="true" /></button>
          </div>
        )}
      </section>

      <div ref={log} role="log" aria-label="Conversation" aria-live="polite" className="relative min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <div className="flex gap-2.5">
          <BotMark />
          <div className="min-w-0 flex-1 space-y-1.5">
            <p className="text-[13.5px] leading-relaxed text-slate-100">
              I find answers in the public reports, tables and maps for the Cooper, Adavale, Galilee and North Bowen basins. I cite the page, show results on the map, and say Not found when the data doesn't cover your question.
            </p>
            <p className="text-[11px] text-slate-300">Ready · Grounded in {plural(lib.documents, "document")} and {lib.passages.toLocaleString("en-US")} passages</p>
          </div>
        </div>
        {!thread.length && !pending && (
          <ul aria-label="Suggested questions" className="flex flex-wrap gap-1.5 pl-[42px]">
            {chips.map(([label, q]) => <li key={label}><button type="button" data-copilot="chip" title={q} className={chip} onClick={() => ask(q, "text")}>{label}</button></li>)}
          </ul>
        )}
        {thread.map((a, i) => (
          <Fragment key={a.id}>
            <UserMsg text={a.question} voice={meta[a.id]?.via === "voice"} />
            <Reply a={a} at={meta[a.id]?.at ?? now} now={now} latest={i === thread.length - 1 && !pending} speaking={speaking === a.id} canTalk={talkOk}
              onTalk={() => { if (speaking === a.id) { stopSpeaking(); setSpeaking(null); } else talk(a.id, a); }}
              onShow={(x) => handOff(() => p.onShow(x))} onOpenFull={(x) => handOff(() => p.onOpenFull(x))} onHypothesis={(id) => handOff(() => p.onHypothesis(id))} onFollow={onFollow} />
          </Fragment>
        ))}
        {pending && <UserMsg text={pending.text} voice={pending.via === "voice"} />}
        {busy && (
          <div data-copilot="busy" className="flex items-start gap-2.5 text-xs text-slate-300" aria-hidden="true">
            <BotMark />
            {p.progress ? (
              <div className="min-w-0 space-y-1 pt-1.5">
                <p className="motion-safe:animate-pulse">The Foundry scientists are working on this answer · {Math.round(p.progress.elapsedMs / 1000)} s</p>
                <p className="text-slate-400">{p.progress.sources ? `They have read ${p.progress.sources} source${p.progress.sources === 1 ? "" : "s"} so far` : "They are choosing which scientists to ask"}</p>
                {p.progress.latest.slice(0, 2).map((l) => <p key={l} className="truncate text-slate-400" title={l}>{l}</p>)}
              </div>
            ) : <span className="pt-2 motion-safe:animate-pulse">Searching the library…</span>}
          </div>
        )}
        {consent && (
          <div role="group" aria-label="Turn on voice input" className="space-y-2 rounded-xl border border-amber-200/30 bg-amber-300/10 p-3 text-xs text-amber-50">
            <p className="font-semibold">Voice input leaves this computer</p>
            <p className="leading-relaxed">To turn speech into text, the browser sends your voice to its online speech service (Edge and Chrome both do). Typed questions and spoken replies stay on this computer.</p>
            <div className="flex flex-wrap gap-1.5">
              <button type="button" className="rounded-lg bg-amber-200 px-2.5 py-1.5 text-xs font-semibold text-[#2A1A00] hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-100" onClick={() => { setMicOk(true); startListening(); }}>Turn on voice input</button>
              <button type="button" className={chip} onClick={() => { setConsent(false); input.current?.focus(); }}>Not now</button>
            </div>
          </div>
        )}
      </div>

      {(notice || listening) && (
        <p role="status" className="mx-4 mb-2 flex shrink-0 items-center gap-2 text-xs text-slate-200">
          {listening && <span className="size-2 rounded-full bg-rose-400 motion-safe:animate-pulse" aria-hidden="true" />}
          {listening ? "Listening. Ask your question, then pause." : notice}
        </p>
      )}

      <form onSubmit={(e) => { e.preventDefault(); ask(text, "text"); }} className="mx-4 mb-4 shrink-0 rounded-xl border border-white/15 bg-white/[0.04] transition-colors focus-within:border-copilot-300/60">
        <textarea ref={input} value={text} rows={2} maxLength={300} aria-label="Message the exploration copilot" placeholder="Ask about the basins, wells or plays…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); ask(text, "text"); } }}
          className="block max-h-32 w-full resize-none bg-transparent px-3 pt-2.5 text-sm text-white placeholder:text-slate-400 focus:outline-none" />
        <div className="flex items-center justify-between gap-2 px-2 pb-2">
          <div className="flex items-center gap-1">
            <IconBtn label="Add a document to search" onClick={p.onAddDoc}><Plus aria-hidden="true" /></IconBtn>
            {micAvailable && <IconBtn label={listening ? "Stop listening" : "Speak a question"} live={listening} onClick={toggleMic}><Mic aria-hidden="true" /></IconBtn>}
          </div>
          <button type="submit" aria-label="Send" disabled={!text.trim() || busy}
            className="grid size-8 place-items-center rounded-lg bg-copilot-300 text-copilot-ink transition-colors hover:bg-copilot-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-copilot-200 disabled:opacity-40">
            <ArrowUpRight className="size-4" aria-hidden="true" />
          </button>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-1.5">
          <p className="text-[11px] leading-snug text-slate-300">{how.footer}</p>
          <IconBtn label="Open the full answers" onClick={() => handOff(p.onOpenAnswers)}><MessageSquareText aria-hidden="true" /></IconBtn>
        </div>
      </form>
    </aside>
    </>
  );
}
