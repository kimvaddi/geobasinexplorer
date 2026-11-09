// Writes the knowledge-graph kits from the same code the app uses:
//   <folder>/ontology/*.ttl                    OWL/Turtle, one file per graph variant
//   <folder>/fabric-iq-kit/entities/*.csv      one table per entity type (for Fabric IQ ontology binding)
//   <folder>/fabric-iq-kit/relationships/*.csv one table per relationship type
// Run from the repo root: node tools/run-ts.mjs tools/export-kits.ts <folder>. ingestion-framework/tools/make_bundle.py runs it
// with <bundle>/processed/geology, where the knowledge build's producers read the kit.
import fs from "node:fs";
import path from "node:path";
import { getKG, toTurtle, schema, CLASS_NAME, TYPE_LABEL, PRED_LABEL, type KG, type NType } from "@/lib/kg";

const out = path.resolve(process.argv[2] ?? "data");
const csv = (rows: (string | number | null | undefined)[][]) =>
  rows.map((r) => r.map((v) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\n") + "\n";
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

const variants: { name: string; g: KG }[] = [
  { name: "geobasin-exploration", g: getKG({ ccs: false, lowc: false }) },
  { name: "geobasin-with-lowcarbon", g: getKG({ ccs: true, lowc: true }) },
];
for (const v of variants) {
  write(path.join(out, "ontology", `${v.name}.ttl`), toTurtle(v.g));
  console.log(`ontology/${v.name}.ttl  nodes ${v.g.nodes.size}  edges ${v.g.edges.length}`);
}

// Fabric IQ kit from the exploration graph (the default view).
const g = variants[0].g;
const kit = path.join(out, "fabric-iq-kit");
const byType = new Map<NType, string[][]>();
for (const n of g.nodes.values()) {
  const rows = byType.get(n.type) ?? [];
  rows.push([n.id, n.label, n.basin ?? "", n.lonlat ? n.lonlat[0].toFixed(5) : "", n.lonlat ? n.lonlat[1].toFixed(5) : "", n.lonlat ? "GDA94 (EPSG:4283)" : "",
    n.source.title, n.source.id, n.source.publisher, n.source.licence, JSON.stringify(Object.fromEntries(n.props))]);
  byType.set(n.type, rows);
}
const head = ["id", "label", "basin_id", "lon", "lat", "crs", "source_title", "source_id", "publisher", "licence", "properties_json"];
for (const [t, rows] of byType) write(path.join(kit, "entities", `${CLASS_NAME[t]}.csv`), csv([head, ...rows]));
const byPred = new Map<string, string[][]>();
for (const e of g.edges) {
  const s = g.nodes.get(e.s)!, o = g.nodes.get(e.o)!;
  const rows = byPred.get(e.p) ?? []; rows.push([e.s, CLASS_NAME[s.type], e.o, CLASS_NAME[o.type]]); byPred.set(e.p, rows);
}
for (const [p, rows] of byPred) write(path.join(kit, "relationships", `${p}.csv`), csv([["source_id", "source_type", "target_id", "target_type"], ...rows]));
const sc = schema(g);
write(path.join(kit, "schema.csv"), csv([
  ["kind", "name", "label", "from", "to", "count"],
  ...sc.classes.map(([t, n]) => ["entity", CLASS_NAME[t], TYPE_LABEL[t], "", "", n]),
  ...sc.rels.map((r) => ["relationship", r.p, PRED_LABEL[r.p], CLASS_NAME[r.from], CLASS_NAME[r.to], r.n]),
]));
console.log(`fabric-iq-kit: ${byType.size} entity tables, ${byPred.size} relationship tables`);
