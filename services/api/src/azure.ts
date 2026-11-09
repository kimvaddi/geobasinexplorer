// Azure clients. Every call uses Microsoft Entra ID: the container's managed identity in Azure,
// the operator's Azure CLI sign-in when scripts run on a workstation. No keys anywhere.
import { AzureCliCredential, ManagedIdentityCredential, getBearerTokenProvider, type TokenCredential } from "@azure/identity";
import OpenAI from "openai";
import { GeographyPoint, SearchClient, SearchIndexClient } from "@azure/search-documents";
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueClient } from "@azure/storage-queue";
import { TableClient } from "@azure/data-tables";
import DocumentIntelligence, { type DocumentIntelligenceClientOptions } from "@azure-rest/ai-document-intelligence";
import { cfg } from "./config";

export const credential: TokenCredential = process.env.IDENTITY_ENDPOINT
  ? new ManagedIdentityCredential({ clientId: process.env.AZURE_CLIENT_ID })
  : new AzureCliCredential();

let _ai: OpenAI | null = null;
/* GPT-6 Astra and the Grok validator share the Foundry resource's OpenAI-compatible v1 endpoint (Microsoft Learn, use-foundry-models-grok). */
export function ai(): OpenAI {
  if (!_ai) _ai = new OpenAI({ baseURL: `${cfg.foundryEndpoint()}/openai/v1`, apiKey: getBearerTokenProvider(credential, "https://ai.azure.com/.default"), timeout: 30_000, maxRetries: 1 });
  return _ai;
}

export interface Passage { key?: string; id: string; doc: string; page: number; heading: string; text: string; basin: string | null; well: string | null; kind: string; visibility: string; owner: string; docId: string; source: string; vector?: number[];
  /* Geo fields: see geo.ts. */
  points?: GeographyPoint[]; places?: string[]; placeHow?: string[]; geoBasins?: string[]; geotag?: string }
let _search: SearchClient<Passage> | null = null;
export const search = () => (_search ??= new SearchClient<Passage>(cfg.searchEndpoint(), cfg.index, credential));
export const searchIndexes = () => new SearchIndexClient(cfg.searchEndpoint(), credential);

const blobUrl = () => `https://${cfg.storageAccount()}.blob.core.windows.net`;
export const blobs = () => new BlobServiceClient(blobUrl(), credential);
export const queue = () => new QueueClient(`https://${cfg.storageAccount()}.queue.core.windows.net/ingest-jobs`, credential);
export const table = (name: string) => new TableClient(`https://${cfg.storageAccount()}.table.core.windows.net`, name, credential);
// Explicit API pinning for the live layout recipe; legacy callers retain their existing defaults.
// https://learn.microsoft.com/javascript/api/@azure-rest/ai-document-intelligence/documentintelligenceclientoptions
export const docIntel = (options?: DocumentIntelligenceClientOptions) => DocumentIntelligence(cfg.docIntelEndpoint(), credential, options);

/* Embeddings for passages and questions (text-embedding-3-large, 3,072 dimensions). */
export async function embed(texts: string[], options?: { signal?: AbortSignal; maxRetries?: number; onUsage?: (tokens: number) => void }): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 64) {
    const r = await ai().embeddings.create({ model: cfg.deployments.embed, input: texts.slice(i, i + 64) }, { signal: options?.signal, maxRetries: options?.maxRetries });
    options?.onUsage?.(r.usage.total_tokens);
    out.push(...r.data.map((d) => d.embedding as number[]));
  }
  return out;
}
