# Ontology ingestion framework

This folder holds a reusable, automated data-loading framework for Microsoft Fabric IQ. It takes the entities and relationships that upstream processes produce, lands them in a Fabric lakehouse, prepares typed tables for binding, generates the ontology through the Fabric REST API, checks the result, and connects the ontology to a Microsoft Foundry agent. The core package knows nothing about geology. The GeoBasin producers in [`producers/`](producers/) are its first use, and another domain needs only its own producers and a configuration file.

Building an ontology by hand means designing every entity type, promoting properties out of JSON, keying the relationship tables and binding each one, which is slow and easy to get wrong when the source material runs to thousands of documents about basins, wells, rock units, reservoirs and the relationships between them. Here a producer describes what it found once, in a simple folder contract, and the framework does the rest the same way every time, however many entity types there are.

## The six steps

| Step | What happens | How it runs |
|---|---|---|
| 1. Prepare entities and relationships | Each producer writes one dataset folder with its entities, relationships and properties, and with descriptions, synonyms and units for each of them. | `python -m producers`, through `ontology_ingest.contract.DatasetWriter` |
| 2. Upload to the lakehouse | The framework inspects the landing folders and uploads them to OneLake. It copies every source file into a raw schema, expands JSON properties into typed columns, checks that every relationship points at real entities, and writes one table per entity type and one junction table per relationship type. | `land`, then `prepare` in the prepare notebook |
| 3. Create the ontology | A Fabric notebook renders the ontology definition and calls the REST API to create or update the entity types, relationship types and data bindings, then reads the definition back and checks it. | `generate` in the generate notebook |
| 4. Query the ontology | Every table's row count is compared with the plan, and the ontology's MCP endpoint can be asked a question. The ontology agent in the Fabric portal answers from the same data. | `verify --mcp-smoke` |
| 5. Build and explore the graph | The framework publishes a graph model over the same binding tables, with one node type per entity type and one edge type per relationship type, reloads it and checks every node and edge count against the plan. It then reports the graph's labels and runs GQL queries against it. | `graph-model`, which `run` includes, then `graph` |
| 6. Connect to Foundry | The ontology endpoint becomes a Fabric IQ tool connection in a Foundry project, and an agent answers questions through it. | `python -m foundry_agent` |

Only the first graph build needs a person. Microsoft documents that a graph model defined through the REST API can't load data until someone has opened it once in the graph model editor in the Fabric portal ([Manage data in graph](https://learn.microsoft.com/fabric/graph/manage-data)), so after the first `graph-model`, open the new graph model once; from then on every run reloads and checks the graph by itself. The framework builds this separate graph model rather than the ontology's built-in graph because **Manage graph** reports every entity type published through the public API as an unsupported data source. [FABRIC_KNOWLEDGE.md](../docs/FABRIC_KNOWLEDGE.md) explains why.

Steps 2 to 5 can also run inside Fabric as a Data Factory pipeline. The files still travel from this computer to the lakehouse's Files area through `land`, and from there a metadata-driven pipeline lists the dataset folders, copies every entity and relationship file into a raw table, and runs three notebooks. The first expands the nested JSON and builds the typed tables, the second creates the ontology and its data bindings, and the third builds the graph model. The pipeline can be started from the Fabric portal with nothing more than a run id, or from here with `run --engine pipeline`. [FABRIC_KNOWLEDGE.md](../docs/FABRIC_KNOWLEDGE.md) describes it in full.

## Quick start

You need Python 3.10 or newer, an Azure CLI sign-in (`az login`) with contributor access to the Fabric workspace, and a running Fabric capacity. Step 6 also needs access to the Foundry project. Nothing is stored as a secret: the CLI uses your Azure CLI sign-in, and the notebooks use the identity of whoever runs them.

```bash
cd ingestion-framework
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[delta,test]'
pip install "azure-ai-projects>=2.2.0" azure-identity      # only for step 6

# Step 1: assemble the data bundle (needs `npm ci` in app/ for the kit), then write the dataset folders
python tools/make_bundle.py --out ../build/bundle --wsm ../build/downloads/WSM_Database_2025.csv
python -m producers --bundle ../build/bundle --out build/landing

# Steps 2 to 5: land, deploy the notebooks, prepare, generate, verify and build the graph model
python -m ontology_ingest --config config/geobasin.json run --mcp-smoke

# Or steps 2 to 5 as a Fabric pipeline: land, deploy the pipelines, run them in Fabric and verify
python -m ontology_ingest --config config/geobasin.json --run-id run2 run --engine pipeline --mcp-smoke

# Step 5: list the graph's labels and ask it a question
python -m ontology_ingest --config config/geobasin.json graph
python -m ontology_ingest --config config/geobasin.json graph --query-file queries/galilee-deepest-wells.gql

# Step 6: connect the ontology to a Foundry agent and ask it a question
python -m foundry_agent connect --config config/geobasin.json --foundry config/geobasin-foundry.json
python -m foundry_agent agent   --config config/geobasin.json --foundry config/geobasin-foundry.json
python -m foundry_agent ask     --config config/geobasin.json --foundry config/geobasin-foundry.json "How deep is the Taroom Trough?"
```

The producers read a data bundle, described in [The data bundle](#the-data-bundle) below; `--bundle` points them at it and `--only` runs a subset. Each live run needs its own run identifier, because a landed snapshot never changes. Without `--run-id`, the run is named after the current UTC time. A pipeline run's identifier becomes part of a schema name inside a pipeline expression, so it must use lowercase letters, digits and underscores, such as `run2`.

## The data bundle

The producers read a data bundle: a folder holding the curated packs, the curated knowledge-graph kit and the well extractions under `processed/`, the public downloads some producers need under `source/`, and an optional per-file manifest `SOURCE_MANIFEST.csv`. [`tools/make_bundle.py`](tools/make_bundle.py) assembles it from this repository: it copies the application packs from `app/src/data` (with withheld sources already removed), writes the well and seismic extractions from them, and generates the kit with the app's own graph code (`tools/export-kits.ts`, which needs `npm ci` in `app/`). The one public download is the World Stress Map Database Release 2025 (https://doi.org/10.5880/WSM.2025.001), which `--wsm` adds as `source/geospatial/world-stress-map-2025/WSM_Database_2025.csv` for the `wsm` producer. A producer whose input is missing is skipped with a message naming the file, and `--strict` turns that into an error. The `sources` producer also reads a snapshot of the live lane's published manifest when `GBX_LIVE_MANIFEST` names one, and leaves the library part out without it. [docs/KNOWLEDGE_INPUTS.md](docs/KNOWLEDGE_INPUTS.md) describes every input, how to fetch the manifest and the counts to expect.

## How each step works

### Step 1: the dataset contract

A landing root holds any number of dataset folders, and each folder follows contract version 1:

- `dataset.json` names the dataset and gives its title, description and priority, which decides whose value wins when two datasets describe the same entity. It can also describe each entity type, relationship type and property, with synonyms, units and data types.
- `entities/<Type>.csv` (or `.jsonl`) holds `id` and `label`, any flat columns, and a `properties_json` column for everything else.
- `relationships/<relation>.csv` (or `.jsonl`) holds `source_id`, `source_type`, `target_id` and `target_type`.

Producers write these files through `DatasetWriter`, which merges duplicate entities, removes duplicate edges and refuses to leave stale files behind:

```python
from ontology_ingest.contract import DatasetWriter

writer = DatasetWriter("landing/example", name="example", title="Example assets", priority=80)
writer.entity_type("Asset", description="An asset in the inventory.")
writer.relationship_type("partOf", description="An asset belongs to another asset.")
writer.add_entity("Asset", id="a", label="Assembly", properties={"height": "25 m"})
writer.add_entity("Asset", id="b", label="Component", properties={"height": "2 m"})
writer.add_relationship("partOf", "b", "Asset", "a", "Asset")
writer.close()
```

### Step 2: landing and preparation

`land` freezes the landing folder and uploads it to `Files/landing/<run id>/` with eight parallel uploads, writing the manifest only after every file has arrived. It also uploads a content-hashed archive of this package, which the notebooks import. `prepare` then reads every dataset. It keeps each source file as a table of strings in the raw schema, expands `properties_json` into columns, treats placeholders such as "not recorded" as empty, derives numbers from quantities such as "3,852 m" or "2,616.6–3,942.6 m", casts each column to a type, merges entities that share an id by dataset priority, and sets aside any relationship whose endpoints do not exist. Finally it writes the typed binding tables. Each run writes to its own pair of schemas, such as `raw_run1_13894b2bcfe4` and `dbo_run1_604faadee06c`, so the published ontology never reads a half-written table.

### Step 3: generating the ontology

The generate notebook first makes sure the lakehouse's SQL analytics endpoint has picked up every binding table. It then renders the definition in TMDL: entity types with their keys, display names, descriptions and synonyms, relationship types backed by the junction tables, and bindings to the run's schema. It creates or updates the ontology, reads the definition back and compares its structure and row counts with the plan. Only after those checks pass does it record the publication and delete runs older than the retention count, which by default keeps the current and the previous run. Lineage tags come from the type and property names and the schema base rather than the run, so an update keeps every tag the service already knows.

### Step 4: querying the ontology

`verify` recounts every table, and `--mcp-smoke` (or `mcp_smoke` in the configuration) calls the ontology's MCP endpoint, whose tools are `ask_ontology`, `list_ontology_entities` and `list_ontology_rules`. How well the ontology answers depends on its descriptions, so the producers describe every entity type, relationship and property and say where to look. For example, the Basin description explains that troughs and depocentres inside a basin are StructuralElement records linked to it by `locatedIn`, and that is what lets the agent find the Taroom Trough.

### Step 5: the graph

`graph-model` publishes the graph model named by `graph_model_name` over a run's binding tables. Each entity type becomes a node type with the same name, keyed on `id` and carrying every property, and each relationship type becomes an edge type labelled with its relation, such as `locatedIn`, between the two node types it connects. The command creates or updates the item through the [Graph Model API](https://learn.microsoft.com/rest/api/fabric/graphmodel/items), reloads it with the [RefreshGraph job](https://learn.microsoft.com/rest/api/fabric/graphmodel/background-jobs/run-on-demand-refresh-graph), and then checks that the loaded graph has exactly the planned node and edge types and that every node and edge count equals the plan. `run` ends with this step whenever `graph_model_name` is set, and the step can also be run on its own for a published run:

```bash
python -m ontology_ingest --config config/geobasin.json --run-id run1 graph-model
```

The first load of a new graph model can't finish until the model has been opened once in the graph model editor in the Fabric portal; open it, then run `graph-model` again. When a graph has been loaded, `graph` lists its node labels with their keys and its edge labels with the nodes they connect, and `--query` or `--query-file` runs GQL against it:

```bash
python -m ontology_ingest --config config/geobasin.json graph
python -m ontology_ingest --config config/geobasin.json graph --query-file queries/galilee-deepest-wells.gql
```

The query in [`queries/galilee-deepest-wells.gql`](queries/galilee-deepest-wells.gql) returns the same five wells as the second evaluation question below. GQL reserves several common property names, among them `label`, `type` and `year`, so write them in backticks, as in `` w.`label` ``; without them the query fails with a syntax error at that word. Until a graph has been loaded, `graph` exits with status 3 and explains what to do instead of showing a raw HTTP error. Without `graph_model_name`, `graph` reads the graph model that Fabric creates beside the ontology, which stays empty for an ontology published by this framework.

### Step 6: the Foundry agent

`connect` creates a RemoteTool connection in the Foundry project that points at the ontology's MCP endpoint and passes on the signed-in user's Microsoft Entra token, so every query runs with that person's own Fabric permissions ([Fabric IQ tool](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/fabric-iq)). `agent` creates the agent, or a new version of it, with the Fabric IQ tool and instructions that tell it to query the ontology before answering, to keep units exactly as the data gives them and to say plainly when the data does not hold the answer. It refuses to add a version to an existing agent that is not wired to this ontology's connection unless `--force` is given. `ask` runs in background mode, because Foundry stops a synchronous MCP tool call after 100 seconds and an ontology query can take longer ([known limitations](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/model-context-protocol#known-limitations)).

## Configuration

The framework reads one JSON file and the Foundry commands read a second. Both ship as examples: copy [`config/geobasin.example.json`](config/geobasin.example.json) to `config/geobasin.json` and [`config/geobasin-foundry.example.json`](config/geobasin-foundry.example.json) to `config/geobasin-foundry.json`, then fill in your own identifiers (the deployment script `infra/scripts/deploy.sh fabric` writes both for you, and git ignores the copies). `config/geobasin.json` names the workspace, the lakehouse, the ontology and its description (Fabric allows at most 256 characters), the landing and output folders, and optionally the run identifier, the schema bases, the publication mode, the retention count, the notebook and pipeline names, the MCP smoke test and the name of the graph model to build (`graph_model_name`). `config/geobasin-foundry.json` names the subscription, resource group, Foundry account and project, the connection, the agent and the model deployment. Relative paths are resolved from the configuration file's folder, unknown keys are refused, and neither file has anywhere to put a secret. The full schema is in [DESIGN.md](docs/DESIGN.md#configuration-schema-and-command-semantics).

Staged publication is the default. Set `"publish_mode": "in_place"` only if you deliberately want every run to overwrite the same schemas, which gives up the immutable snapshots and the rollback they allow.

## Commands

| Command | What it does |
|---|---|
| `land` | Uploads the landing folder and the package archive to OneLake. |
| `deploy-notebooks` | Creates or updates the prepare and generate notebooks, and the graph notebook when `graph_model_name` is set. |
| `prepare [--engine fabric\|local]` | Writes the raw and binding tables, in the notebook or on this computer. Both engines read and write OneLake. |
| `generate [--engine fabric\|local]` | Refreshes SQL metadata, publishes the ontology definition and checks it. |
| `verify [--mcp-smoke]` | Recounts every table, checks the definition and optionally queries the MCP endpoint. |
| `graph-model` | Publishes the graph model over the run's binding tables, reloads it and checks its node and edge counts against the plan. Needs `graph_model_name`. |
| `deploy-pipeline` | Deploys the notebooks and creates or updates the two Fabric pipelines, the ingest pipeline and the copy pipeline it calls for each dataset. Run `land` first, because the pipeline passes the landed archive to its notebooks. |
| `run-pipeline` | Runs the ingest pipeline for the run id, waits for it and writes every activity, child runs included, to `pipeline-run.json`. |
| `run [--engine fabric\|local\|pipeline] [--mcp-smoke]` | Runs `land`, `deploy-notebooks`, `prepare`, `generate` and `verify` in order, then `graph-model` when `graph_model_name` is set. With `--engine pipeline` it runs `land`, `deploy-pipeline`, `run-pipeline` and `verify`, and the pipeline builds the graph model. It stops at the first error. |
| `graph [--query GQL \| --query-file FILE]` | Without a query, reports whether the graph can be queried and lists its labels; with one, runs it. |

Every command accepts `--config` and `--run-id`. `--dry-run` plans a run offline: it reads the landing folder, prepares the tables in memory and writes the plan, the quality report, the TMDL definition, the two pipeline definitions and, when `graph_model_name` is set, the graph model definition under the output folder, without signing in or calling Fabric. The exit status is 0 on success, 2 on an error, and 3 when the graph can't be queried yet.

## The GeoBasin run

Seven producers turn the GeoBasin data into contract folders. Where two datasets describe the same entity, the higher priority wins property by property. The kit links each well to the basin package it was mapped in, while `locatedIn` means inside the basin outline, so its producer leaves out the two well links that the Geoscience Australia borehole layer contradicts (Snatcher 2 and Eromanga 1); each well's `package_id` still names its package.

| Dataset | Source | Priority |
|---|---|---:|
| `geobasin-kit` | GeoBasin curated knowledge-graph kit | 100 |
| `geobasin-well-reports` | Values and findings read from scanned well reports | 90 |
| `geobasin-provenance` | GeoBasin sources and file provenance | 85 |
| `ga-basin-packages` | Geoscience Australia basin packages (TEGI) | 80 |
| `geobasin-app-pack` | GeoBasin application pack | 70 |
| `ga-oztemp` | OzTemp well temperatures | 60 |
| `wsm-2025-australia` | World Stress Map 2025 (Australia) | 60 |

With every producer's inputs in the bundle, records that share an id are merged and duplicate edges removed, and the ontology `geobasin_knowledge` holds 30 entity types and 53 relationship types, about 29,000 entities and 26,500 edges in 83 binding tables. The graph model `geobasin_graph` mirrors it node for node and edge for edge. A full build typically takes minutes rather than hours, from the command line or through the Fabric pipeline, and both routes produce the same counts.

## Evaluation

Six evaluation questions, each checked against the source data, test whether an agent answers correctly from the ontology. The table gives the answer the source data supports, so a run of the Foundry agent `gbx-ontology-explorer` can be scored against it.

| Question | Answer from the source data |
|---|---|
| Which stratigraphic units in the Adavale Basin are reservoirs with a tight-gas resource flag, and what are their lithology and play intervals? | Buckabie Formation (sandstone, Buckabie Play) and Lissoy Sandstone (lithology not recorded, Lissoy–Bury Play) |
| List the five deepest wells inside the Galilee Basin outline with their total depth in metres, year and type. | Log Creek 1 (4,440 m, 1965), Gilmore 1 (4,346 m, 1964), Gilmore 3 (4,205 m, 1965), Leopardwood 1 (4,184 m, 1966) and Gilmore 2 (4,143 m, 1965), all petroleum wells |
| How deep is the Taroom Trough? Give the maximum, mean and 90th percentile depth to the basin floor in metres. | 10,046 m, 8,759 m and 9,755 m across its depocentre zone |
| Which core images come from Cooper Basin wells, and which stratigraphic units do they show? Summarise by well. | 37 images from the 11 wells inside the Cooper Basin outline, each with the unit the kit links to it |
| What is the highest temperature measured in Innamincka 1, at what depth, and from which source? | 138 °C at 3,851 m, from OzTemp |
| What is the dominant stress regime in the North Bowen Basin, and how many World Stress Map records lie inside it? | 855 records, among which thrust faulting (TF) dominates the records with a known regime |

The Cooper question depends on the kit producer leaving out package-based well links that the borehole layer contradicts; with those links, a well whose own record places it outside the basin outline would be counted inside it. The second question can also be asked of the graph model through GQL with [`queries/galilee-deepest-wells.gql`](queries/galilee-deepest-wells.gql).

## Rollback and removal

Because each run keeps its own schemas, publishing an earlier run again restores it, as long as retention still keeps that run. These commands put an earlier run back, first in the ontology and then in the graph model, and running them again with the latest run's identifier returns to it:

```bash
python -m ontology_ingest --config config/geobasin.json --run-id <earlier run id> generate --engine fabric
python -m ontology_ingest --config config/geobasin.json --run-id <earlier run id> graph-model
```

Keep `retain_runs` at two or more, so that the tables the graph model reads still exist until `graph-model` moves it to a new run. To remove everything the framework created, delete the ontology (Fabric deletes its own graph model, eventhouse and KQL database with it), the graph model named by `graph_model_name`, the three notebooks, the two pipelines and the lakehouse, and in Foundry delete the agent and the connection.

## Troubleshooting

- **A description is refused.** Fabric limits item descriptions to 256 characters, so the configuration check refuses a longer `ontology_description` before anything is uploaded.
- **The SQL refresh reports NotRun.** The SQL analytics endpoint says NotRun when nothing has changed. The framework accepts that only when the endpoint also reports a last successful sync and lists every binding table.
- **The SQL refresh reports a failure for a table the ontology doesn't bind.** The lakehouse is shared, so only the binding tables have to sync; any other table that fails is logged as a warning and the publish continues.
- **A pipeline run id is refused.** It becomes part of a schema name inside a pipeline expression, which can't rewrite it, so use lowercase letters, digits and underscores, such as `run2`.
- **Tables named like `<table>_backup_<guid>` appear beside the raw tables.** A copy activity leaves these behind when its table action is the undocumented `Overwrite` rather than the documented `OverwriteSchema`, which the pipeline now uses. Delete any that remain from older pipelines.
- **`land` fails with "HTTP transport failed".** The OneLake endpoint stopped accepting connections for a moment. Run `land` again; the manifest is written only after every file has arrived, so a failed upload leaves nothing half-landed.
- **A long-running operation points at a regional host.** Fabric can return a Location header on a regional host. The client polls the operation on the API host by its `x-ms-operation-id` instead, so the token never goes anywhere else.
- **"No element with lineage tag ... in DataSources".** An update kept a table's name but changed its lineage tag. Tags derive from names and the schema base for exactly this reason, so do not edit them by hand.
- **A Foundry answer times out after about 100 seconds.** That is the synchronous MCP limit. `ask` uses background mode unless you pass `--sync`.
- **An ontology query returns an empty response.** The MCP client retries once when the endpoint answers without a result, which happened once after a long query.
- **GraphNotQueryable.** No graph has been loaded yet, or a load is still running. Run `graph-model` and let it finish.
- **The first graph refresh waits or fails.** A graph model created through the REST API loads nothing until it has been opened once in the graph model editor in the portal. Open it, then run `graph-model` again.
- **Manage graph marks every entity type Ineligible, as an unsupported data source.** That is expected for an ontology published through the public API, which keeps only one of the eight connection annotations that the portal writes. Use the graph model from `graph-model` instead; [FABRIC_KNOWLEDGE.md](../docs/FABRIC_KNOWLEDGE.md) has the details.
- **A GQL query fails with a syntax error.** Look for a reserved word, such as `label`, `type` or `year`, used as a name, and write it in backticks.
- **Every call fails.** Check that the Fabric capacity is running; a paused capacity refuses every request. From the repository root, `python3 infra/scripts/fabric_capacity.py resume` resumes it, waits until it is active and warms the graph.
- **Files named like `fabric 2.py` appear.** A sync client such as iCloud Drive can leave conflict copies when files are rewritten quickly. The archive builder refuses such names. Keep `landing_root` and `output_dir` outside any synced folder.

## Tests

Run `python3 -m pytest` from this folder. The suite never touches the network, because it blocks sockets and Azure CLI sign-ins. The real-Delta test runs only when `deltalake` is installed, and the producer tests that need the GeoBasin data bundle skip when it is absent.

## Layout

```
ontology_ingest/   The framework: contract, preparation, Delta and OneLake writers, TMDL rendering, the graph model, Fabric and
                   MCP clients, notebooks, the Fabric pipelines, publication and retention, graph queries and the command line
producers/         The seven GeoBasin producers, the shared vocabulary of descriptions and synonyms, and their runner
foundry_agent/     Step 6: the Fabric IQ connection, the agent and background-mode questions
config/            Example configuration for the Fabric workspace and the Foundry project
queries/           GQL queries for the graph, starting with the Galilee evaluation question
docs/DESIGN.md     Design decisions, the configuration schema, platform behaviours and limitations
tests/             Offline tests, with golden TMDL files
```
