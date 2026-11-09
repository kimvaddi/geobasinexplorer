# The library in OneLake

The live lane keeps every source file in a storage account that is closed to the internet. This part of the solution brings that library into Microsoft Fabric without moving a single file out of it, writes it as medallion Delta tables, and publishes the search index from the gold layer with the Azure AI Search OneLake files indexer. It also lets Fabric extract documents itself. `infra/scripts/deploy.sh library` sets it all up, and `infra/scripts/fabric_library.py` is the operator command behind it.

## How Fabric reads a closed storage account

The storage account keeps its public network access disabled. Fabric reaches it through trusted workspace access, which admits one named workspace through a resource instance rule and works even when public access is disabled ([trusted workspace access](https://learn.microsoft.com/fabric/security/security-trusted-workspace-access)). The workspace gets a workspace identity, a service principal that Fabric manages, so the connection behind the shortcuts uses no key or secret ([workspace identity](https://learn.microsoft.com/fabric/security/workspace-identity)). The identity is a Contributor of its own workspace, as Learn's prerequisites ask.

The identity reads no more than it needs. It holds Storage Blob Delegator on the account and Storage Blob Data Reader on three containers only:

- `raw`, the clean files once they have passed the gates;
- `processed`, the extractions;
- `manifests`, the publication history.

It never sees quarantine, the page images, the tables or the queues. Learn documents this pairing of a delegator role on the account with data access granted lower down ([Azure Blob Storage shortcut](https://learn.microsoft.com/fabric/onelake/shortcuts/create-blob-shortcut)). The roles come from [infra/bicep/library-access.bicep](../infra/bicep/library-access.bicep). The resource instance rule comes from `fabricWorkspaceIds` in [main.bicep](../infra/bicep/main.bicep) and [modules/data.bicep](../infra/bicep/modules/data.bicep), which take the workspace from `GBX_FABRIC_WORKSPACE_ID`; the same module keeps the rule that Microsoft Defender for Storage writes for malware scanning.

The lakehouse `geobasin_library_lh` has schemas enabled. Its bronze layer is three Azure Blob Storage shortcuts, `Files/bronze/raw`, `Files/bronze/processed` and `Files/bronze/manifests`, created over a Fabric connection that authenticates as the workspace identity. Fabric tests that connection when it creates it, so a missing rule or role fails at once rather than in a notebook.

## Silver and gold

The notebook **geobasin_library silver** finds every extraction bundle that the live lane's `gbx-process` job has written, approved or not. It checks each page and chunk as the live publisher does, and appends new extractions to `silver.documents`, `silver.pages` and `silver.chunks`. Extractions never change, so a rerun reads only extractions that silver doesn't hold yet. A row in `silver.documents` always marks a complete extraction.

The notebook **geobasin_library gold** reads the current publication manifest and its whole history, and binds each selected extraction to silver. It refuses to write gold unless silver backs the publication in full: every document present, every count agreeing, every licence matching the approved source, and every registered well location present. It then rewrites `gold.sources`, `gold.documents` and `gold.chunks`, and records the publication in `gold.publications`. Each gold passage carries the manifest version that first published it, which is the provenance the live publisher stamps on what it pushes.

The checks live in [ontology_ingest/library.py](../ingestion-framework/ontology_ingest/library.py), which mirrors the live publisher (`services/api/src/live/pipeline-publish.ts`) and is tested in [tests/test_library.py](../ingestion-framework/tests/test_library.py). The notebooks embed that module verbatim when they are deployed, so the tested code is the code that runs in Fabric. The pipeline **geobasin_library publish** runs silver and then gold.

## Publishing from gold

Gold also writes one JSON file per published passage under `Files/gold/evidence`. Each file carries exactly the fields the live publisher uploads, with points as GeoJSON and vectors written with the nine significant digits that reproduce Azure AI Search's single-precision values. Each file is named by a hash of its chunk id, because the id can be longer than a file name may be. A file whose bytes are already right is left alone, so the indexer's change detection sees only new or corrected passages.

The search service has a system-assigned managed identity, declared in [modules/ai.bicep](../infra/bicep/modules/ai.bicep). That identity holds the Contributor role on the workspace, the minimum Learn sets for the OneLake files indexer ([index data from OneLake files](https://learn.microsoft.com/azure/search/search-how-to-index-onelake-files)). The data source `gbx-library-gold` points at `gold/evidence`. The indexer `gbx-library-gold` parses each file into `gbx-evidence-onelake`, a field-for-field copy of the push index `gbx-evidence-v2`, and it tolerates no failed item.

`fabric_library.py run` publishes in this order:

1. It runs the pipeline.
2. It runs the indexer on demand and waits for it.
3. It verifies that the index holds exactly the publication's passages and that each one matches the push index field for field.
4. Only then does it move the gold pointer, `Files/gold/_publication/current.json`.

Any failure leaves the pointer where it was.

The first time a run passes, `deploy.sh library` sets `GBX_V2_LIBRARY_INDEX=gbx-evidence-onelake` and redeploys the site. From then on, the site reads live passages from the gold index whenever that index holds every passage of the current publication. It counts the index once for each manifest version, using the same selection that serving filters by. A publication the indexer hasn't reached yet, or any failed count or search, is served from the push index, so the switch adds no new way for an answer to fail. The site logs a `live-evidence-index` event whenever its choice changes.

## Extraction in Fabric

The notebook **geobasin_library extract** extracts documents inside Fabric:

1. It reads each selected document's bytes through `Files/bronze/raw` and checks them against the recorded document hash.
2. It analyses them with Document Intelligence's `prebuilt-layout` model at API version 2024-11-30 with UTF-16 offsets, as `gbx-process` does.
3. It normalises the result with a Python port of the live lane's layout normaliser.
4. It embeds the chunks with the platform's `gbx-embed` deployment.
5. It compares every chunk with the one `gbx-process` produced, and writes `silver.fabric_pages`, `silver.fabric_chunks` and `silver.extraction_parity`.

It authenticates as the person who runs it, with a Microsoft Entra token for Cognitive Services from `notebookutils.credentials.getToken`, so no key exists anywhere. The operator already holds the Cognitive Services and Azure OpenAI user roles the foundation grants. `--max-pages` (60 by default) refuses a run that would analyse more pages than that.

This extraction is a proven twin of `gbx-process`, not yet its replacement. Three things are needed before it can publish:

- page images rendered in Fabric;
- an extraction version of its own;
- a review screen that reads silver.

## Running it

```bash
infra/scripts/deploy.sh library   # after the fabric phase; rerun after each approval to publish from gold
```

The individual commands, which take the same settings:

```bash
python3 infra/scripts/fabric_library.py status
python3 infra/scripts/fabric_library.py extract --sources <source id>,<source id> --max-pages 60
```

## Prerequisites

- **Capacity.** Trusted workspace access works only on purchased Fabric capacities (F SKUs), not on trial capacities.
- **Tenant settings.** A Fabric administrator must allow service principals to use Fabric APIs, and apps outside Fabric to reach OneLake data, which the indexer needs.
- **Workspace role.** The operator must be an admin of the workspace in order to create its identity.
