// The Azure AI Search passage index, shared by build-index.ts (a fresh index) and geo-backfill.ts (adds the geo
// fields to a live one). New fields can be added to a live index; existing fields can't be changed without a rebuild.
import { cfg } from "../src/config";

export const definition = {
  name: cfg.index,
  fields: [
    { name: "key", type: "Edm.String", key: true, filterable: true },
    { name: "id", type: "Edm.String", filterable: true },
    { name: "doc", type: "Edm.String", searchable: true, filterable: true },
    { name: "page", type: "Edm.Int32", filterable: true, sortable: true },
    { name: "heading", type: "Edm.String", searchable: true },
    { name: "text", type: "Edm.String", searchable: true, analyzerName: "en.microsoft" },
    { name: "basin", type: "Edm.String", filterable: true },
    { name: "well", type: "Edm.String", filterable: true },
    { name: "kind", type: "Edm.String", filterable: true },
    { name: "visibility", type: "Edm.String", filterable: true },
    { name: "owner", type: "Edm.String", filterable: true },
    { name: "docId", type: "Edm.String", filterable: true },
    { name: "source", type: "Edm.String" },
    { name: "vector", type: "Collection(Edm.Single)", searchable: true, hidden: true, vectorSearchDimensions: 3072, vectorSearchProfileName: "vp" },
    // Geo fields (src/geo.ts): places on the map in GDA94, their names and how each was found, the basins the passage
    // belongs to, and whether it is tied to a place (point, basin, general or none).
    { name: "points", type: "Collection(Edm.GeographyPoint)", filterable: true },
    { name: "places", type: "Collection(Edm.String)", filterable: true },
    { name: "placeHow", type: "Collection(Edm.String)" },
    { name: "geoBasins", type: "Collection(Edm.String)", filterable: true, facetable: true },
    { name: "geotag", type: "Edm.String", filterable: true, facetable: true },
  ],
  vectorSearch: {
    algorithms: [{ name: "hnsw", kind: "hnsw", parameters: { metric: "cosine", m: 4, efConstruction: 400, efSearch: 500 } }],
    profiles: [{ name: "vp", algorithmConfigurationName: "hnsw" }],
  },
};
