# The live ingestion lane

The live lane turns registered public documents into searchable, citable evidence. It fetches each source from its publisher, verifies it against a pinned checksum, scans it, reads it with Azure Document Intelligence, extracts and embeds it, waits for an expert's approval, and only then publishes it to the Azure AI Search index and the manifest that the app and the agents read. Every stage fails closed: a missing permission is never treated as approval, a changed checksum is recorded but never published, and a failed publication leaves the previous manifest in place. This README is the operator's guide; [docs/ARCHITECTURE.md](../../../../docs/ARCHITECTURE.md) places the lane in the wider platform and [docs/DATA_SOURCES.md](../../../../docs/DATA_SOURCES.md) lists the sources it serves.

## The parts

`pipeline-registry.ts` holds the source registry: each source's identifier, title, publisher, licence, attribution, the basis on which its licence was confirmed, the pinned SHA-256 of each file and whether it may be published. `live-bootstrap.mjs --seed-registry` writes it to the `sourceregistry` table without overwriting rows an owner has already changed. `contracts.ts` is the shared wire contract, `source-policy.ts` maps sources to the documents they replace, and `scan-verdict.ts` checks a scanner verdict: the exact ClamAV tags, a clean result, the file's SHA-256 and signatures no more than 72 hours old.

The work runs as Container Apps jobs. `gbx-connect` fetches a source from its pinned publisher URL, refuses redirects, verifies the checksum and lands the file in quarantine, then queues it to `scan-jobs` with the route `process-jobs`. The scanner (`services/scanner`) clears or rejects the file and forwards the original message; only a persisted clean verdict lets processing continue. `gbx-process` claims the job, verifies the source and the scan, writes the raw bytes once, accounts for every page and archive member (refusing unsafe archives rather than silently skipping members), reads each page with Document Intelligence's `prebuilt-layout` model, renders page images, chunks the text with its headings and page regions, embeds it, and writes silver records to Table storage with a versioned extraction identity. The tables `sourcereviews`, `lineage`, `silverdocuments`, `silverpages`, `silverchunks`, `pipelinejobs` and `sourceversions` hold the review queue, the lineage, the extraction and the job state.

## Owner review and publication

People with the GeoBasin owner role review and decide through the owner API. `PUT /api/admin/sources/:id/content` lets an owner land a file by hand; the expected hash is mandatory, a mismatch is recorded as a non-publishable version, and a permitted file goes through the same scan and processing. The review list and detail endpoints return each extraction with its samples and an ETag, and a decision must carry that ETag; decisions cannot approve a withheld or uncleared source or change an already-decided review. An approval queues the publication and returns HTTP 202; replaying the same decision is a no-op.

Publication takes a lease, requires the current registry ETag and an approved decision for that exact extraction, checks every page image and chunk, enforces the index cap and verifies the indexing results before it advances the manifest pointer. Partial indexing, a missing image, a missing geotag or a race leaves the old pointer in place, and nothing published is ever deleted.

## Running it

`infra/scripts/deploy.sh content` runs the lane's bootstrap. It creates the evidence index and builds the packaged reference index from the operator's machine, because Azure AI Search and Foundry take Entra-authenticated calls on their public endpoints. It then seeds the registry and lands every source inside the virtual network, as executions of the `gbx-connect` job with the pipeline's own identity ([infra/scripts/live_content.py](../../../../infra/scripts/live_content.py)), because the storage account is reachable only through its private endpoints. Sources whose publishers serve them only to a browser are landed by hand through the owner route with `live_content.py land`. The commands it runs, from `services/api` with the platform's settings exported:

```bash
npm ci && npm run build                                  # after npm ci in app/: the build bundles the app's library code
node dist/scripts/live-bootstrap.mjs --create-index      # creates the evidence index if it is missing
node dist/scripts/build-index.mjs                        # builds the packaged reference index (gbx-passages)
node dist/scripts/live-bootstrap.mjs --seed-registry     # adds registry rows; never overwrites an owner's (inside the network)
node dist/scripts/live-connect.mjs <source id>           # lands one source (inside the network)
```

`GBX_LIVE_SOURCES` lists the sources a revision serves live, and `GBX_LIVE_ROUTE` decides which questions go to them: `matched` sends only questions whose best library matches include a live source, and `all` sends every question the prepared rules do not cover.

## Releasing the serving agent

The live answers come from a serving agent pinned by name and version in the platform Foundry project. Release a new version whenever its instructions or tools change:

```bash
node build.mjs --script scripts/agent-release.ts
node dist/scripts/agent-release.mjs --release <release version>            # plan only: prints the new name and digest
node dist/scripts/agent-release.mjs --release <release version> --create   # creates and verifies the agent version
```

Put the printed name and version in `GBX_LIVE_AGENT_NAME` and `GBX_LIVE_AGENT_VERSION` and redeploy the platform and the site. `GBX_AGENT_TOOL_CALLS` sets the agent's tool-call limit, 12 by default and at most 48. The agent's time budget sits inside Front Door's 120-second origin timeout, with time always reserved for independent validation.

## Rollback and recovery

An earlier approved extraction can be restored explicitly; it goes through a fresh scan and becomes the active version in a new manifest generation, and nothing is deleted:

```bash
node dist/scripts/live-rollback.mjs <source id> <landed sha256> <earlier extraction version> --queue-approved
node dist/scripts/live-retry.mjs <job id> --rescan-processing    # requeues an incomplete extraction through a fresh scan
```

A failed job keeps its quarantine copy, raw versions and checkpoints, so it can resume rather than start again.

## Reading the logs

Every log line is JSON in `ContainerAppConsoleLogs_CL`, and none carries question, statement or evidence text. Lines such as `agent tool calls`, `agent correction requested`, `live answer withheld` and `validator attempt` explain what happened to each answer:

```kusto
ContainerAppConsoleLogs_CL
| where ContainerAppName_s == "gbx-site"
| where Log_s has_any ("live answer withheld", "live interpretation removed", "agent tool calls", "agent correction requested", "validator attempt")
| project TimeGenerated, Log_s
| order by TimeGenerated desc
```

## Things to know

A live question costs roughly 50,000 to 130,000 tokens, almost all of it input, because each round re-reads the conversation, so size the answer deployment's tokens-per-minute quota accordingly; throttled questions are withheld rather than answered unchecked. A new revision's first manifest read can fail closed while it warms, so read `/api/live/manifest` once after a deployment. Foundry refuses overlapping deletes of one conversation's items, so the agent's cleanup deletes items one at a time.

## Tests

```bash
npm run typecheck
npm run build
for t in contracts pipeline pipeline-sdk pipeline-analysis pipeline-infra catalogue-ecat archive-member; do node build.mjs --script "src/live/$t.test.ts"; done
node --test dist/scripts/*.test.mjs
```
