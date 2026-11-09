/* In-browser LAS 1.2/2.0 reader. Runs entirely on this computer: the file is read with FileReader and nothing is sent anywhere.
   Returns the header, curves (decimated for plotting), and every problem found, so extraction quality is visible. */
export interface LasCurveR { mnem: string; unit: string; descr: string; min: number | null; max: number | null; nulls: number; samples: number; pts: [number, number][] }
export interface LasIssue { where: string; what: string; severity: "info" | "warning" | "failure" }
export interface LasRead {
  file: string; bytes: number; version: string; wrap: string; nullValue: number | null; depthUnit: string; start: number | null; stop: number | null; step: number | null;
  well: Record<string, string>; header: { section: string; mnem: string; unit: string; value: string; descr: string }[]; curves: LasCurveR[];
  issues: LasIssue[]; rows: number; parseMs: number; confidence: "High" | "Medium" | "Low"; confidenceWhy: string;
}
const HEADER_LINE = /^\s*([^.\s][^.]*?|)\s*\.(\S*)\s+(.*?)\s*:\s*(.*)$/;
export function parseLas(text: string, file: string, bytes: number): LasRead {
  const t0 = performance.now();
  const issues: LasIssue[] = [];
  const header: LasRead["header"] = [];
  const curvesDef: { mnem: string; unit: string; descr: string }[] = [];
  const well: Record<string, string> = {};
  let section = ""; let version = "not stated"; let wrap = "NO"; let nullValue: number | null = null;
  const data: number[] = [];
  let badTokens = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]; const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("~")) { section = line[1]?.toUpperCase() ?? ""; continue; }
    if (section === "A") {
      for (const tok of line.split(/[\s,]+/)) { if (!tok) continue; const v = Number(tok); if (Number.isFinite(v)) data.push(v); else { badTokens++; data.push(NaN); } }
      continue;
    }
    if (section === "O") continue;
    const m = HEADER_LINE.exec(raw);
    if (!m) { issues.push({ where: `Line ${i + 1} (~${section})`, what: `Could not read header line: “${line.slice(0, 60)}”`, severity: "warning" }); continue; }
    const [, mnemRaw, unit, value, descr] = m; const mnem = mnemRaw.trim().toUpperCase();
    header.push({ section, mnem, unit, value: value.trim(), descr: descr.trim() });
    if (section === "V") { if (mnem === "VERS") version = value.trim(); if (mnem === "WRAP") wrap = value.trim().toUpperCase(); }
    if (section === "W") {
      const v = value.trim(), d = descr.trim();
      const stdDesc = /^(well( name)?|company|field|location|province|county|state|country|service company|log date|date|unique well id|uwi|api number|licen[cs]e number|start depth|stop depth|step|null value)$/i.test(d);
      if (v) well[mnem] = v; else if (d && !stdDesc) { well[mnem] = d; issues.push({ where: `~Well ${mnem}`, what: `Value written in the description position (“${d.slice(0, 40)}”)`, severity: "info" }); }
      if (mnem === "NULL") nullValue = Number(v);
    }
    if (section === "C") curvesDef.push({ mnem: mnemRaw.trim(), unit, descr: descr.trim() });
  }
  const nC = curvesDef.length;
  if (!nC) issues.push({ where: "~Curve section", what: "No curve definitions found", severity: "failure" });
  if (nullValue == null || !Number.isFinite(nullValue)) { issues.push({ where: "~Well NULL", what: "No NULL value declared; assuming none", severity: "warning" }); nullValue = null; }
  if (!/^(1\.2|2\.0|2)/.test(version)) issues.push({ where: "~Version VERS", what: `Version “${version}”: only LAS 1.2 and 2.0 are read reliably here`, severity: version === "not stated" ? "warning" : "warning" });
  if (wrap === "YES") issues.push({ where: "~Version WRAP", what: "Wrapped file: values were re-flowed into rows by curve count", severity: "info" });
  if (badTokens) issues.push({ where: "~ASCII data", what: `${badTokens} values were not numbers and were treated as missing`, severity: "warning" });
  const rows = nC ? Math.floor(data.length / nC) : 0;
  if (nC && data.length % nC) issues.push({ where: "~ASCII data", what: `${data.length % nC} trailing values did not fill a complete row and were ignored`, severity: "warning" });
  const depthUnit = curvesDef[0]?.unit || well.STRT && header.find((h) => h.mnem === "STRT")?.unit || "not stated";
  const num = (k: string) => { const v = Number(well[k]); return Number.isFinite(v) ? v : null; };
  const start = num("STRT"), stop = num("STOP"), step = num("STEP");
  const curves: LasCurveR[] = curvesDef.map((c, ci) => {
    let min = Infinity, max = -Infinity, nulls = 0; const pts: [number, number][] = [];
    const every = Math.max(1, Math.ceil(rows / 1200));
    for (let r = 0; r < rows; r++) {
      const d = data[r * nC]; const v = data[r * nC + ci];
      const isNull = !Number.isFinite(v) || (nullValue != null && Math.abs(v - nullValue) < 1e-6);
      if (isNull) { nulls++; continue; }
      if (v < min) min = v; if (v > max) max = v;
      if (r % every === 0 && Number.isFinite(d)) pts.push([d, v]);
    }
    if (!c.unit && ci > 0) issues.push({ where: `Curve ${c.mnem}`, what: "No unit given", severity: "warning" });
    if (rows && nulls === rows && ci > 0) issues.push({ where: `Curve ${c.mnem}`, what: "Every sample is NULL", severity: "failure" });
    else if (rows && nulls / rows > 0.5 && ci > 0) issues.push({ where: `Curve ${c.mnem}`, what: `${Math.round((100 * nulls) / rows)}% of samples are NULL`, severity: "warning" });
    return { mnem: c.mnem, unit: c.unit, descr: c.descr, min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null, nulls, samples: rows, pts };
  });
  if (rows > 2 && nC) {
    const d0 = data[0], d1 = data[nC], dl = data[(rows - 1) * nC];
    if (start != null && Number.isFinite(d0) && Math.abs(d0 - start) > Math.abs(step ?? 0) + 1e-6) issues.push({ where: "~Well STRT", what: `Header start ${start} does not match first data depth ${d0}`, severity: "warning" });
    if (stop != null && Number.isFinite(dl) && Math.abs(dl - stop) > Math.abs(step ?? 0) + 1e-6) issues.push({ where: "~Well STOP", what: `Header stop ${stop} does not match last data depth ${dl}`, severity: "warning" });
    if (step != null && step !== 0) {
      let irregular = 0;
      for (let r = 1; r < rows; r++) { const dd = data[r * nC] - data[(r - 1) * nC]; if (Math.abs(dd - step) > Math.abs(step) * 0.01 + 1e-9) irregular++; }
      if (irregular) issues.push({ where: "Depth index", what: `${irregular} depth steps differ from the declared STEP ${step}`, severity: "warning" });
    } else if (step === 0) issues.push({ where: "~Well STEP", what: "STEP is 0: irregular sampling declared", severity: "info" });
    if (Number.isFinite(d0) && Number.isFinite(d1) && d1 < d0) issues.push({ where: "Depth index", what: "Depth decreases down the file (an up-pass or reversed index)", severity: "info" });
  }
  const missing = ["WELL", "UWI", "COMP", "FLD", "LOC", "DATE", "SRVC"].filter((k) => !well[k]);
  if (missing.length) issues.push({ where: "~Well section", what: `Not stated: ${missing.join(", ")}`, severity: missing.some((k) => ["WELL", "LOC", "UWI"].includes(k)) ? "warning" : "info" });
  if (!rows) issues.push({ where: "~ASCII data", what: "No data rows found", severity: "failure" });
  const fails = issues.filter((x) => x.severity === "failure").length, warns = issues.filter((x) => x.severity === "warning").length;
  const confidence = fails ? "Low" : warns > 2 ? "Medium" : "High";
  const confidenceWhy = fails ? `${fails} failure${fails > 1 ? "s" : ""} found` : warns ? `${warns} warning${warns > 1 ? "s" : ""}; values read as written` : "Header and data are consistent";
  return { file, bytes, version, wrap, nullValue, depthUnit: String(depthUnit), start, stop, step, well, header, curves, issues, rows, parseMs: Math.round(performance.now() - t0), confidence, confidenceWhy };
}
