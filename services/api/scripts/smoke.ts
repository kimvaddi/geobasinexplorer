// Smoke test after the foundation deployment (both design reviewers required it before any indexing).
// Runs with the operator's Azure CLI sign-in; every call uses Entra ID, none uses a key.
//   node build.mjs --script scripts/smoke.ts && node dist/scripts/smoke.mjs <path-to-small.pdf>
import fs from "node:fs";
import { ai, credential, docIntel, embed } from "../src/azure";
import { cfg } from "../src/config";
import { getLongRunningPoller, isUnexpected } from "@azure-rest/ai-document-intelligence";

const results: { check: string; ok: boolean; detail: string }[] = [];
const rec = (check: string, ok: boolean, detail: string) => { results.push({ check, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${check}: ${detail}`); };
const time = async <T>(f: () => Promise<T>) => { const t = Date.now(); const v = await f(); return { v, ms: Date.now() - t }; };

try {
  const { v, ms } = await time(() => embed(["Patchawarra Formation reservoir sandstone"]));
  rec("embeddings (gbx-embed, text-embedding-3-large)", v[0]?.length === 3072, `${v[0]?.length} dimensions in ${ms} ms`);
} catch (e) { rec("embeddings (gbx-embed)", false, String((e as Error).message).slice(0, 200)); }

try {
  const { v, ms } = await time(() => ai().chat.completions.create({
    model: cfg.deployments.answer,
    messages: [{ role: "system", content: "Reply with JSON only." }, { role: "user", content: "Return {\"ok\": true, \"model\": \"<your model family>\"}" }],
    response_format: { type: "json_schema", json_schema: { name: "smoke", strict: true, schema: { type: "object", additionalProperties: false, required: ["ok", "model"], properties: { ok: { type: "boolean" }, model: { type: "string" } } } } },
    reasoning_effort: "low", max_completion_tokens: 200,
  } as never));
  const r = v as unknown as { choices: { message: { content: string } }[]; usage?: { total_tokens: number } };
  const parsed = JSON.parse(r.choices[0].message.content);
  rec("answer writer (gbx-answer, GPT-6 Astra, structured output)", parsed.ok === true, `${JSON.stringify(parsed)} in ${ms} ms, ${r.usage?.total_tokens} tokens`);
} catch (e) { rec("answer writer (gbx-answer)", false, String((e as Error).message).slice(0, 300)); }

try {
  const { v, ms } = await time(() => ai().chat.completions.create({
    model: cfg.deployments.validator,
    messages: [{ role: "system", content: "Reply with JSON only, no prose." }, { role: "user", content: "Return {\"ok\": true}" }],
    reasoning_effort: "low", max_completion_tokens: 200,
  } as never));
  const r = v as unknown as { choices: { message: { content: string } }[]; usage?: { total_tokens: number } };
  const text = r.choices[0].message.content ?? "";
  rec("validator (gbx-validator, Grok 4.7)", /"ok"\s*:\s*true/.test(text), `${text.trim().slice(0, 80)} in ${ms} ms, ${r.usage?.total_tokens} tokens`);
} catch (e) { rec("validator (gbx-validator)", false, String((e as Error).message).slice(0, 300)); }

const pdf = process.argv[2];
if (pdf) {
  try {
    const body = fs.readFileSync(pdf);
    const t = Date.now();
    const init = await docIntel().path("/documentModels/{modelId}:analyze", "prebuilt-read").post({ contentType: "application/octet-stream", body });
    if (isUnexpected(init)) throw new Error(JSON.stringify(init.body).slice(0, 300));
    const done = await getLongRunningPoller(docIntel(), init).pollUntilDone();
    const res = (done.body as { analyzeResult?: { pages?: { pageNumber: number; words?: { confidence: number }[] }[]; content?: string } }).analyzeResult;
    const pages = res?.pages ?? [];
    const words = pages.flatMap((p) => p.words ?? []);
    const mean = words.length ? words.reduce((s, w) => s + w.confidence, 0) / words.length : 0;
    rec("Document Intelligence prebuilt-read (Entra)", pages.length > 0, `${pages.length} page(s), ${words.length} words, mean word confidence ${mean.toFixed(3)}, ${Date.now() - t} ms`);
  } catch (e) { rec("Document Intelligence", false, String((e as Error).message).slice(0, 300)); }
}

// Search: an Entra call must succeed and a key call must be refused.
try {
  const token = await credential.getToken("https://search.azure.com/.default");
  const r = await fetch(`${cfg.searchEndpoint()}/servicestats?api-version=2025-09-01`, { headers: { Authorization: `Bearer ${token!.token}` } });
  const body = await r.json() as { counters?: { storageSize?: { usage: number; quota: number } } };
  rec("Search with Entra ID", r.ok, `HTTP ${r.status}; storage ${body.counters?.storageSize?.usage ?? "?"} of ${body.counters?.storageSize?.quota ?? "?"} bytes`);
} catch (e) { rec("Search with Entra ID", false, String((e as Error).message).slice(0, 200)); }
const key = process.env.GBX_SEARCH_ADMIN_KEY;
if (key) {
  const r = await fetch(`${cfg.searchEndpoint()}/servicestats?api-version=2025-09-01`, { headers: { "api-key": key } });
  rec("Search refuses key-based access", r.status === 401 || r.status === 403, `HTTP ${r.status}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} smoke checks passed.`);
process.exit(failed ? 1 : 0);
