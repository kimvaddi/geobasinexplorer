import { LICENCE } from "@/lib/licensed-data";

export { LICENCE };
const provenance = LICENCE.metadata();
const exclude = (field: string, values: string[]) => {
  if (!values.length) return "true";
  const list = [...new Set(values)].join("|").replace(/'/g, "''");
  return `(${field} eq null or not search.in(${field}, '${list}', '|'))`;
};
// Static provenance survives build-time stripping; no restricted passage text is loaded to build the deny list.
// These existing fields are filterable; `source` is not. The post-filter also checks source metadata on
// uploads and unfamiliar ids. Do not exclude a well name here: independently sourced GA borehole data
// may carry the same well tag. search.in syntax: https://learn.microsoft.com/azure/search/search-query-odata-search-in-function
export const CLOUD_LICENCE_FILTER = [
  exclude("id", provenance.passages.map(([id]) => id)),
  exclude("docId", provenance.docIds.map(([id]) => id)),
].join(" and ");
