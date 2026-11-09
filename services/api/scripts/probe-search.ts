import { embed, search } from "../src/azure";
const q = process.argv[2] ?? "What gas shows were recorded in Innamincka 1?";
const [vector] = await embed([q]);
const res = await search().search(q, { top: 5, filter: "visibility eq 'public'", select: ["id", "doc", "page", "heading", "basin"], vectorSearchOptions: { queries: [{ kind: "vector", vector, fields: ["vector"], kNearestNeighborsCount: 24 }] } } as never);
const out: string[] = [];
for await (const r of (res as any).results) out.push(`${r.score.toFixed(4)}  ${r.document.id}  ${r.document.doc} p.${r.document.page}`);
const count = await search().getDocumentsCount();
console.log(`documents: ${count}\nQ: ${q}\n${out.join("\n")}`);
