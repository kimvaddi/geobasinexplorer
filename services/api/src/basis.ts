// The data behind a prepared (Precomputed) answer. The deterministic rules compute over public datasets (the GA
// stratigraphic framework, GA Table 1 and basin statistics, the play tables, legacy-well extractions, the core photo
// catalogue). The independent validator can only confirm a computed claim, including "no unit has this role", if it
// sees the rows the rule used, so this rebuilds those rows as compact evidence. It reads the same bundled data as
// the rules and adds nothing that isn't in it.
import { BASINS, depthAt, inRings, ownUnits, regimeLabel, unitRoles, type Basin, type Borehole, type Unit } from "@/lib/basins";
import { CRITERIA, DEFAULT_WEIGHTS, playById, rank } from "@/lib/analog";
import { APP_DATA } from "@/lib/licensed-data";
import { LICENCE } from "./licence";
import type { Answer5 } from "@/lib/answer5";

const PACK = LICENCE.cloudAppPack(APP_DATA);
const WELLS = PACK.wells;

export interface Evidence { id: string; label: string; text: string }
// About 6,000 tokens of evidence per check. An extract cut at this limit is marked TRUNCATED, and the validator is told
// that a truncated extract can't support a claim that a list or count is complete.
const LIMIT = 24_000;
const v = (x: unknown) => (x === null || x === undefined || x === "" ? "-" : String(x));
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

function basinsIn(det: Answer5, question: string): Basin[] {
  const q = norm(question);
  const ids = new Set<string>([det.basin, det.focusBasin].filter((x): x is string => !!x));
  for (const b of BASINS) if (q.includes(norm(b.name)) || q.includes(norm(b.short)) || q.includes(b.id)) ids.add(b.id);
  return BASINS.filter((b) => ids.has(b.id));
}

const unitRow = (u: Unit) =>
  `${u.n} | ${v(u.rank)} | ${v(u.age)}${u.top != null && u.base != null ? ` (${u.top}-${u.base} Ma)` : ""} | ${v(u.lith)} | ${v(u.env)} | role: ${unitRoles(u).join(", ") || "none recorded"}${u.unc ? ` | resource flag: ${u.unc}` : ""}${u.hydro ? ` | hydrostratigraphy: ${u.hydro}` : ""}${u.play ? ` | play: ${u.play}` : ""}`;

function framework(b: Basin): Evidence {
  const units = ownUnits(b);
  return { id: `framework:${b.id}`, label: `GA stratigraphic framework, ${b.name}`, text: `${units.length} units (name | rank | age | lithology | environment | petroleum role):\n${units.map(unitRow).join("\n")}` };
}

const normName = (x: string) => ` ${x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
/* Boreholes the question names (the same matching as the named-borehole rule: names with a number, longest first). */
function namedBoreholes(b: Basin, question: string): Borehole[] {
  const q = normName(question);
  return b.boreholes.filter((w) => w.name && /\d/.test(w.name) && normName(w.name).length > 5 && q.includes(normName(w.name))).slice(0, 5);
}

function basinFacts(b: Basin, question = ""): Evidence {
  const stats = Object.entries(b.stats ?? {}).filter(([, x]) => x !== null).map(([k, x]) => `${k}: ${x}`).join("; ");
  const zones = (b.zones ?? []).map((z) => `${z.n}: max ${z.max} m, mean ${z.mean} m, p90 ${z.p90} m, area ${z.area} km2, ${z.bh} boreholes`).join("\n");
  const feats = (b.features ?? []).filter((f) => f.fst).slice(0, 40).map((f) => `${f.n} (${f.t}): ${JSON.stringify(f.fst)}`).join("\n");
  const inside = b.boreholes.filter((h) => h.inside);
  const tdCounts = [500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 5000].map((t) => `> ${t} m: ${inside.filter((h) => (h.td ?? 0) > t).length}`).join(", ");
  const deepest = inside.filter((h) => h.td != null).sort((x, y) => (y.td ?? 0) - (x.td ?? 0)).slice(0, 10).map((h) => `${h.name ?? h.key} ${h.td} m (${v(h.year)}, ${v(h.type)})`).join("; ");
  const ss = b.stressSum;
  // The quality A-C records inside the outline, so a statement about how many state a regime can be counted directly.
  const abc = (b.stress ?? []).filter((r) => inRings(r[0], r[1], b.outline) && "ABC".includes(String(r[3])));
  const stressRows = abc.length ? `World Stress Map records inside the outline with quality A-C (${abc.length}; azimuth deg | quality | regime, where ${[...new Set(abc.map((r) => String(r[4])))].map((k) => `${k} = ${k === "U" ? "not stated" : regimeLabel(k)}`).join(", ")}):\n${abc.slice(0, 200).map((r) => `${r[2]} | ${r[3]} | ${r[4]}`).join("\n")}` : "";
  const stress = ss ? `World Stress Map: ${ss.n_in} records inside (${ss.n_ABC_in} of quality A-C), ${ss.n_buffer} in the buffer (${ss.n_ABC_buffer} A-C); axial mean azimuth A-C ${v(ss.mean_azi_ABC)} deg (buffer ${v(ss.mean_azi_ABC_buffer)}), circular std ${v(ss.circ_std)}, dominant regime ${v(ss.dominant_regime)}, nearest record ${v(ss.nearest_km ?? ss.nearest_km_if_none)} km` : "";
  const text = [
    `${b.name} (${b.state}), age ${b.age}. Source: ${b.catalogue.title} (${b.catalogue.year}, eCat ${b.catalogue.ecat}, ${b.catalogue.licence}).`,
    `GA Table 1:\n${b.table1.map((t) => `${t.f}: ${t.v}`).join("\n")}`,
    stats && `Computed statistics: ${stats}`,
    `Outline bounding box (GDA94): ${b.bbox.join(", ")}; centre ${b.center.join(", ")}`,
    zones && `Depocentres from the GA depth grid:\n${zones}`,
    `Boreholes inside the outline: ${inside.length}; by total depth ${tdCounts}. Deepest: ${deepest}`,
    ...namedBoreholes(b, question).map((w) => { const floor = depthAt(b, w.lon, w.lat); return `Borehole named in the question: ${w.name}, ${w.inside ? "inside" : "outside"} the outline, type ${v(w.type)}, year ${v(w.year)}, total depth ${v(w.td)} m, operator ${v(w.operator)}, result ${v(w.result)}, at ${w.lon}, ${w.lat} (GDA94); GA depth-to-basement grid cell there: ${floor == null ? "no value" : `${Math.round(floor)} m`}`; }),
    `Mapped faults: ${b.faults.length} traces; folds: ${b.folds.length}`,
    stress,
    stressRows,
    feats && `Named features with depth statistics:\n${feats}`,
    `Play intervals in the package (${b.plays.length}, of which ${b.plays.filter((p) => /basement/i.test(p.n)).length} named as basement): ${b.plays.map((p) => `${p.n} (${v(p.top)}-${v(p.base)} Ma, ${p.interval}, chronostratigraphic stage ${p.stage})`).join("; ")}`,
  ].filter(Boolean).join("\n");
  return { id: `basin:${b.id}`, label: `GA basin package, ${b.name}`, text };
}

function plays(det: Answer5, basins: Basin[]): Evidence {
  const scored = new Map((det.why?.scores ?? []).map((s) => [s.id, s.score]));
  const ids = new Set(basins.map((b) => b.id));
  // Rules that search every basin (analogs, same-age plays, resource flags) need every play row.
  const rows = PACK.plays.filter((p) => scored.has(p.id) || !ids.size || p.basins.some((b) => ids.has(b)) || /same-age|analog|resource-flag/i.test(det.why?.rule ?? ""));
  return {
    id: "plays", label: "GA play tables",
    text: `${rows.length} plays (play | province | GA basin package | age range Ma | interval | chronostratigraphic stage | depositional environment | lithology | resource flags | petroleum roles | units). The tables record which resource types each play is flagged for; they have no column for resource size, volume or prospectivity:\n` +
      rows.map((p) => `${p.play} | ${p.province} | ${p.basins.join(", ")} | ${v(p.top)}-${v(p.base)} | ${p.interval} | ${p.stage} | ${p.env.join(", ") || "-"} | ${p.lith.join(", ") || "-"} | ${p.res.join(", ") || "none"} | ${p.roles.join(", ") || "-"} | ${p.units.map((u) => `${u.n} (${u.basin})`).join(", ")}`).join("\n"),
  };
}

/* For an analog ranking: the formula, the weights and every part of each listed play's score, so the validator can
   recompute the scores from the play rows instead of taking them on trust. */
function analogBreakdown(det: Answer5): Evidence | null {
  const ref = det.analogRef ? playById(det.analogRef) : null;
  if (!ref) return null;
  const listed = new Set((det.why?.scores ?? []).map((x) => x.id));
  const ranked = rank(ref, DEFAULT_WEIGHTS).filter((r) => listed.has(r.play.id));
  const w = DEFAULT_WEIGHTS;
  const total = Object.values(w).reduce((s0, x) => s0 + x, 0);
  const f = (x: number | null) => (x == null ? "no data (left out)" : x.toFixed(3));
  return {
    id: "analog-scores", label: `Analog score parts for the ${ref.play} (${ref.province})`,
    text: [
      `Reference play: ${ref.play} | ${ref.province} | ${v(ref.top)}-${v(ref.base)} Ma | environment ${ref.env.join(", ") || "-"} | lithology ${ref.lith.join(", ") || "-"} | resource flags ${ref.res.join(", ") || "none"} | roles ${ref.roles.join(", ") || "not recorded"}.`,
      `Weights: ${CRITERIA.map((c) => `${c.label} ${w[c.id]}`).join(", ")} (total ${total}). Candidates are plays in other provinces.`,
      "Parts: age = 0.5 + 0.5 x min(1, overlap / shorter range) when the ranges overlap, else 0.5 x max(0, 1 + overlap / 40); environment and lithology = shared items / all distinct items, left out if either side has none; resource flags = the same ratio, left out only if neither side has any, and no flag on both sides counts as no data; roles = the same ratio, left out if either side has none.",
      "Score = 100 x sum(weight x part) / sum(weights of the parts with data), rounded to one decimal. Coverage = sum(weights of the parts with data) / total weight, as a whole percent.",
      ...ranked.map((r) => `${r.play.play} (${r.play.province}): age part ${f(r.parts.age)} (overlap ${r.overlapMyr == null ? "-" : r.overlapMyr.toFixed(1)} Myr), environment ${f(r.parts.env)}, lithology ${f(r.parts.lith)}, resource ${f(r.parts.res)}, roles ${f(r.parts.roles)} -> score ${r.score}, coverage ${r.coverage}%`),
    ].join("\n"),
  };
}

/* For a glossary answer about plays: every package's play list, so a stated count can be checked. */
function playCounts(): Evidence {
  return { id: "play-counts", label: "Play intervals in each GA basin package", text: BASINS.map((b) => `${b.short}: ${b.plays.length} play intervals, ${b.plays.filter((p) => /basement/i.test(p.n)).length} of them basement (${b.plays.map((p) => p.n).join(", ")})`).join("\n") };
}

function wells(question: string): Evidence[] {
  const q = norm(question);
  return WELLS.filter((w) => q.includes(norm(w.name)) || q.includes(norm(w.name).replace(/ 1$/, ""))).map((w) => ({
    id: `well:${w.siteId}`, label: `${w.name}: values read from the scanned reports`,
    text: `${w.name}, ${w.basinId}, spud ${v(w.spudYear)}, operator ${v(w.operator)}, total depth ${v(w.totalDepthM)} m.\n` +
      w.fields.map((f) => `${f.group} / ${f.label}: ${f.value}${f.unit ? ` ${f.unit}` : ""}${f.valueSI != null ? ` (${f.valueSI} ${f.unitSI ?? ""})` : ""}${f.depthM != null ? ` at ${f.depthM} m` : ""}${f.formation ? `, ${f.formation}` : ""}; page ${f.page}; read with ${f.confidence} confidence${f.needsReview ? ", flagged for expert review" : ""}${/unit implied/i.test(f.unit ?? "") ? "; the unit is implied: the page prints only the degree sign, and the unit comes from the log headers" : ""}; quote: "${f.quote.slice(0, 240)}"${f.note ? `; extraction note: ${f.note}` : ""}`).join("\n") +
      (w.findings.length ? `\nFindings: ${w.findings.map((f) => `${f.topic}: ${f.text} (page ${f.page})`).join(" | ")}` : ""),
  }));
}

/* The checkshot table and time-depth chart (Enclosures 1 and 2) that the well rules compare report tops against. */
function velocity(question: string): Evidence | null {
  const vel = PACK.velocity;
  const site = vel ? WELLS.find((w) => w.siteId === vel.well) : undefined;
  if (!vel || !site || !norm(question).includes(norm(site.name).replace(/ 1$/, ""))) return null;
  return {
    id: `velocity:${vel.well}`, label: `${site.name}: checkshot table and time-depth chart (${vel.source.report})`,
    text: vel.items.map((it) => `${it.title} (${it.itemId}):\n` + (it.values ?? []).map((x) => `${x.label}: ${x.value}${x.note ? ` (${x.note})` : ""}`).join("\n")).join("\n"),
  };
}

function photos(question: string): Evidence | null {
  const q = norm(question);
  const s = question.toLowerCase();
  // Same matching as the prepared core-photo rule (answer5 coreAnswer), so the check sees exactly the rows it used.
  const key = (n: string) => n.toLowerCase().replace(/ play interval$| formation$| sandstone$| beds$| group$| coal measures$/i, "").split(/[ -]/)[0];
  const rows = PACK.core.photos.filter((p) => [p.formation, p.play ?? ""].some((n) => { const k = key(n); return k.length > 3 && s.includes(k); })
    || (Array.isArray(p.wells) ? p.wells : [p.wells ?? ""]).some((w) => w && q.includes(norm(w))));
  const strips = PACK.core.strips.filter((x) => { const k = x.unit.toLowerCase().split(/[ -]/)[0]; return k.length > 3 && s.includes(k); });
  if (!rows.length && !strips.length) return null;
  return {
    id: "core-photos", label: "GA core photo catalogue and Cooper Basin core photo panels",
    text: [
      ...rows.slice(0, 40).map((p) => `photo ${p.file} | ${p.formation} | play: ${v(p.play)} | wells: ${Array.isArray(p.wells) ? p.wells.join(", ") : v(p.wells)} | depths m: ${(p.depths_m ?? []).join(", ") || "-"}`),
      ...strips.slice(0, 60).map((x) => `panel | ${x.unit} | well: ${x.well} | ${x.top}–${x.base} m`),
    ].join("\n"),
  };
}

/* Evidence for the validator: only the dataset families the rule draws on, capped in size. */
export function basisFor(det: Answer5, question: string): Evidence[] {
  const rule = det.why?.rule ?? "";
  const basins = basinsIn(det, question);
  const out: Evidence[] = [];
  if (/framework|stratigraphic unit|unit roles/i.test(rule)) out.push(...basins.map(framework));
  if (/table 1|basin age|overview|comparison|where is a basin|basin depth|depth statistics|borehole|stress|faults/i.test(rule)) out.push(...(/comparison/i.test(rule) ? BASINS : basins).map((b) => basinFacts(b, question)));
  if (/analog/i.test(rule)) { const a = analogBreakdown(det); if (a) out.push(a); }
  if (/play tables|analog|same-age|resource-flag/i.test(rule)) out.push(plays(det, basins));
  if (/definition/i.test(rule) && /play/i.test(question)) out.push(playCounts());
  if (/legacy-well/i.test(rule)) { out.push(...wells(question)); const vel = velocity(question); if (vel) out.push(vel); }
  if (/core photo/i.test(rule)) { const p = photos(question); if (p) out.push(p); }
  let used = 0;
  return out.map((e) => {
    const room = Math.max(0, LIMIT - used);
    const text = e.text.length > room ? `${e.text.slice(0, room)}\n[TRUNCATED: ${e.text.length - room} more characters of this extract are not shown, so it is not the complete dataset]` : e.text;
    used += text.length;
    return { ...e, text };
  }).filter((e) => !e.text.startsWith("\n[TRUNCATED"));
}
