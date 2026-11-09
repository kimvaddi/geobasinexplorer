import { PHASE1A_V1_DOC_IDS } from "./source-policy";
import type { PublicationManifest, LiveEvidenceRecord } from "./contracts";
import { LIVE_INDEX_NAME, validateManifest } from "./contracts";
import type { ToolContext } from "./agent-tools";
import type { AgentReply, AgentTransport, AgentJournal, CleanupRecord } from "./agent-client";
import type { EvidenceSearch } from "./serving-evidence";
import type { CloudAnswer } from "../answer";
import { cfg } from "../config";

export const extractionVersion = `layout-v1-${"c".repeat(64)}-11111111-2222-4333-8444-555555555555`;
export const artifactHash = "a".repeat(64), documentHash = "b".repeat(64);
export function manifestFixture(version = 1): PublicationManifest {
  const sourceId = "peps-sa-marabooka-1";
  return validateManifest({ schemaVersion: 1, manifestVersion: version, createdAt: "2026-11-02T16:10:00.000Z", indexName: LIVE_INDEX_NAME,
    sources: [{ sourceId, sha256: artifactHash, extractionVersion, title: "Marabooka 1 report", publisher: "PEPS South Australia", url: "bundle-copy", licence: "CC BY 4.0", attribution: "PEPS South Australia", licenceBasis: "Owner-confirmed CC BY 4.0", publishAllowed: true, visibility: "public", v1DocIds: [...PHASE1A_V1_DOC_IDS["peps-sa-marabooka-1"]],
      documents: [{ docId: "marabooka-report", sha256: documentHash, title: "Marabooka 1 report", pageCount: 420, chunkCount: 800 }],
      wellLocation: { lon: 140.6102, lat: -28.176, datum: "GDA94" },
      approval: { sourceId, sha256: artifactHash, extractionVersion, decision: "approved", reason: "Reviewed the original pages.", by: "owner-test", at: "2026-11-02T16:00:00.000Z" } }],
  });
}
export function bothManifestFixture(version = 1): PublicationManifest {
  const manifest = manifestFixture(version), ga = structuredClone(manifest.sources[0]);
  ga.sourceId = "ga-147461"; ga.sha256 = "e".repeat(64); ga.publisher = "Geoscience Australia"; ga.title = "Cooper guide";
  ga.wellLocation = null; ga.v1DocIds = [...PHASE1A_V1_DOC_IDS["ga-147461"]];
  ga.documents = [{ docId: "guide", sha256: "f".repeat(64), title: "Cooper guide", pageCount: 20, chunkCount: 40 }];
  ga.approval = { ...ga.approval, sourceId: ga.sourceId, sha256: ga.sha256 };
  return validateManifest({ ...manifest, sources: [...manifest.sources, ga] });
}
export function liveHit(overrides: Partial<LiveEvidenceRecord> = {}): LiveEvidenceRecord {
  return { id: "live_c1_v1", sourceId: "peps-sa-marabooka-1", sha256: artifactHash, extractionVersion, documentSha256: documentHash,
    docId: "marabooka-report", page: 25, headingPath: ["Formation tops"], text: "Top Toolachee 6326 ft below KB. Report KB elevation 181.9 ft.", basin: "cooper", well: "marabooka-1", visibility: "public", owner: "", vector: [],
    boundingRegionsSummary: [], points: [], places: [], placeHow: [], geoBasins: ["cooper"], geotag: "basin", publishAllowed: true, manifestVersion: 1, licence: "CC BY 4.0", attribution: "PEPS South Australia", ...overrides };
}
export function contextFixture(): ToolContext { return { user: { id: "caller", name: "Caller", owner: false, roles: [] }, manifest: manifestFixture(), near: null, requiredSourceIds: ["peps-sa-marabooka-1"] }; }
export const evidenceFixture = (): EvidenceSearch => ({ live: async () => [liveHit()], packaged: async () => [] });
export const baseAnswer = (): CloudAnswer => ({ id: "a1", question: "What is the Toolachee top in Marabooka 1 below KB and sea level?", status: "unsupported", basin: "cooper", paragraphs: [], provenance: [], citations: [], focus: null, focusBasin: "cooper", highlight: [], followUps: [], why: { terms: [], rule: "", scores: [] }, label: "Not found", hits: [], reason: "", trace: [], engine: "azure", tokens: 0,
  validation: { status: "not-run", validator: "Grok 4.1 Fast", checked: 0, supported: 0, removed: [], note: "" } });
export function fakeAgent(replies: AgentReply[]) {
  const calls: string[] = [], journalRecords: CleanupRecord[] = [], submitted: unknown[] = []; let n = 0, deleting = 0, items: string[] = ["item-1"];
  const client: AgentTransport = {
    verify: async (s) => { s.throwIfAborted(); calls.push("verify"); },
    createConversation: async (s) => { s.throwIfAborted(); calls.push("conversation"); return "conv-1"; },
    respond: async (c, input, s, timeout) => { s.throwIfAborted(); if (c !== "conv-1" || timeout <= 0 || timeout > Math.max(15_000, cfg.live.agentCallMs)) throw new Error("Bad response SDK contract"); calls.push("respond"); submitted.push(input); return replies[n++] ?? { id: `r${n}`, status: "completed", text: "", output: [], tokens: 1 }; },
    listItems: async (_c, s) => { s.throwIfAborted(); calls.push("listItems"); return items; },
    // Mirrors the live service: a delete that overlaps another delete in the same conversation is refused with 412.
    deleteItem: async (_c, i, s) => {
      s.throwIfAborted(); calls.push(`deleteItem:${i}`); if (deleting) throw { status: 412 };
      deleting++; try { await new Promise((r) => setTimeout(r, 1)); items = items.filter((id) => id !== i); } finally { deleting--; }
    },
    deleteResponse: async (id, s) => { s.throwIfAborted(); calls.push(`deleteResponse:${id}`); },
    getResponse: async (_id, s) => { s.throwIfAborted(); throw { status: 404 }; },
    deleteConversation: async (_id, s) => { s.throwIfAborted(); calls.push("deleteConversation"); },
    getConversation: async (_id, s) => { s.throwIfAborted(); throw { status: 404 }; },
  };
  const journal: AgentJournal = { save: async (r) => { calls.push("save"); journalRecords.push(structuredClone(r)); }, complete: async () => { calls.push("complete"); } };
  return { client, journal, calls, journalRecords, submitted, setItems: (ids: string[]) => { items = [...ids]; } };
}
export const functionReply = (name = "search_live_evidence", args = { query: "Toolachee KB" }): AgentReply => ({ id: "r1", status: "completed", text: "", tokens: 123, output: [{ type: "function_call", name, arguments: JSON.stringify(args), call_id: "call-1" }] });
export type FixtureStatement = { kind: "fact" | "interpretation"; text: string; cites: string[] };
export const statementsReply = (sentences: FixtureStatement[], id = "r2"): AgentReply => ({ id, status: "completed", text: JSON.stringify({ answerable: true, sentences, missing: [] }), output: [{ type: "message" }], tokens: 234 });
export const answerReply = (text = "Top Toolachee is 6326 ft below KB.", cites = ["L1"]): AgentReply => statementsReply([{ kind: "fact", text, cites }]);
