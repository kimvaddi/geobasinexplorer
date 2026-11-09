// Definition only: importing this module never creates an index or calls Azure.
import type { SearchField, SearchIndex } from "@azure/search-documents";
import { LIVE_INDEX_NAME, LIVE_VECTOR_DIMENSIONS, type LiveEvidenceRecord } from "../src/live/contracts";

// SDK field attributes, including the single string key and non-sortable collections:
// https://learn.microsoft.com/javascript/api/@azure/search-documents/simplefield
// The extra owner/docId fields keep geo.ts accessFilter (including the licence denylist) usable on v2.
const fields: (SearchField & { name: keyof LiveEvidenceRecord })[] = [
  { name: "id", type: "Edm.String", key: true, filterable: true, hidden: false },
  { name: "sourceId", type: "Edm.String", filterable: true },
  { name: "sha256", type: "Edm.String", filterable: true },
  { name: "extractionVersion", type: "Edm.String", filterable: true },
  { name: "documentSha256", type: "Edm.String", filterable: true },
  { name: "docId", type: "Edm.String", filterable: true },
  { name: "page", type: "Edm.Int32", filterable: true, sortable: true },
  { name: "headingPath", type: "Collection(Edm.String)", searchable: true },
  { name: "text", type: "Edm.String", searchable: true, analyzerName: "en.microsoft" },
  // Vector dimensions match azure.ts embed(), with no indexer or service-side vectorizer.
  // Vectors must be searchable and cannot be filterable, sortable or facetable; the profile must exist.
  // https://learn.microsoft.com/azure/search/vector-search-how-to-create-index#add-a-vector-field-to-the-fields-collection
  // https://learn.microsoft.com/azure/search/cognitive-search-skill-azure-openai-embedding#supported-dimensions-by-modelname
  { name: "vector", type: "Collection(Edm.Single)", searchable: true, hidden: true, filterable: false, sortable: false, facetable: false,
    vectorSearchDimensions: LIVE_VECTOR_DIMENSIONS, vectorSearchProfileName: "live-vector" },
  // Full polygons remain in silver; these native-unit bounding boxes are a retrievable summary.
  // https://learn.microsoft.com/javascript/api/@azure/search-documents/complexfield
  { name: "boundingRegionsSummary", type: "Collection(Edm.ComplexType)", fields: [
    { name: "page", type: "Edm.Int32" }, { name: "x", type: "Edm.Double" }, { name: "y", type: "Edm.Double" },
    { name: "width", type: "Edm.Double" }, { name: "height", type: "Edm.Double" }, { name: "unit", type: "Edm.String" },
  ] },
  // Names and point collection match GeoFields (0.11.0); preserve its explicit GDA94 convention.
  // GeographyPoint fields cannot be faceted, and collections cannot be sorted.
  // https://learn.microsoft.com/javascript/api/@azure/search-documents/simplefield#facetable
  // https://learn.microsoft.com/javascript/api/@azure/search-documents/simplefield#sortable
  { name: "points", type: "Collection(Edm.GeographyPoint)", filterable: true, facetable: false, sortable: false },
  { name: "places", type: "Collection(Edm.String)", filterable: true },
  { name: "placeHow", type: "Collection(Edm.String)" },
  { name: "geoBasins", type: "Collection(Edm.String)", filterable: true, facetable: true },
  { name: "geotag", type: "Edm.String", filterable: true, facetable: true },
  { name: "basin", type: "Edm.String", filterable: true },
  { name: "well", type: "Edm.String", filterable: true },
  { name: "licence", type: "Edm.String", filterable: true },
  { name: "attribution", type: "Edm.String" },
  { name: "publishAllowed", type: "Edm.Boolean", filterable: true },
  { name: "manifestVersion", type: "Edm.Int32", filterable: true, sortable: true },
  { name: "visibility", type: "Edm.String", filterable: true },
  { name: "owner", type: "Edm.String", filterable: true },
];

export const definition = {
  name: LIVE_INDEX_NAME,
  fields,
  vectorSearch: {
    // Cosine is the documented metric for Azure OpenAI embeddings; retain the v1 HNSW settings.
    // https://learn.microsoft.com/azure/search/vector-search-how-to-create-index#add-a-vector-search-configuration
    // https://learn.microsoft.com/javascript/api/@azure/search-documents/hnswparameters
    algorithms: [{ name: "live-hnsw", kind: "hnsw", parameters: { metric: "cosine", m: 4, efConstruction: 400, efSearch: 500 } }],
    profiles: [{ name: "live-vector", algorithmConfigurationName: "live-hnsw" }],
  },
} satisfies SearchIndex;
