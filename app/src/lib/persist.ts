import { useCallback, useEffect, useState } from "react";
import { GATED } from "@/lib/cloud";

/* Browser storage for scores, reviews, notes and the guided tour progress. Some managed browsers block storage for
   local files; then everything lives in memory for this session and the app asks people to export. */
// Do not reopen notes, scores or cached evidence saved by a cloud build before the source gate.
const storageKey = (key: string) => GATED ? `gbx-cloud-licence-20261102-r2:${key}` : key;
const MEM = new Map<string, string>();
export const STORAGE_OK = (() => { try { const k = "__gbx_probe"; window.localStorage.setItem(k, "1"); window.localStorage.removeItem(k); return true; } catch { return false; } })();
export function readKey<T>(key: string, fallback: T): T {
  try { const raw = STORAGE_OK ? window.localStorage.getItem(storageKey(key)) : MEM.get(key) ?? null; return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}
export function writeKey<T>(key: string, value: T) {
  const s = JSON.stringify(value);
  if (STORAGE_OK) { try { window.localStorage.setItem(storageKey(key), s); return; } catch { /* fall through */ } }
  MEM.set(key, s);
}
export function removeKey(key: string) { if (STORAGE_OK) { try { window.localStorage.removeItem(storageKey(key)); } catch { /* ignore */ } } MEM.delete(key); }
const listeners = new Map<string, Set<() => void>>();
export function usePersistent<T>(key: string, initial: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readKey(key, initial));
  useEffect(() => {
    const set = listeners.get(key) ?? new Set(); listeners.set(key, set);
    const fn = () => setValue(readKey(key, initial));
    set.add(fn); return () => { set.delete(fn); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback((next: T | ((prev: T) => T)) => {
    const prev = readKey(key, initial);
    const v = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
    writeKey(key, v); listeners.get(key)?.forEach((f) => f());
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, update];
}
export const KEYS = { score: "gbx-score", custom: "gbx-custom-questions", reviewer: "gbx-reviewer", review: "gbx-review", log: "gbx-review-log", track: "gbx-track", notes: "gbx-notebook", answers: "gbx-last-answer", copilotVoice: "gbx-copilot-voice", copilotMic: "gbx-copilot-mic-ok", copilotDock: "gbx-copilot-dock", copilotWidth: "gbx-copilot-width", sideWidth: "gbx-side-width", mapWindow: "gbx-map-window" } as const;
