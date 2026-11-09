# Fabric knowledge build

Microsoft Fabric holds GeoBasin Explorer AI's knowledge model:

- a **lakehouse** of typed entity and relationship tables;
- an **ontology** bound to those tables;
- a **graph model** over the same tables.

Who reads it:

| Reader | How |
|---|---|
| Scientist agents | Query the ontology through Fabric IQ, as the signed-in user |
| The app's tool server | Reads the graph for knowledge cards and typed knowledge tools |
| Analysts | Explore both in the Fabric portal |

This guide explains how the model is built, run and kept available. For the framework's design notes, see [ingestion-framework/docs/DESIGN.md](../ingestion-framework/docs/DESIGN.md). For its command reference, see [ingestion-framework/README.md](../ingestion-framework/README.md).

## See it in Fabric

Two short videos, recorded live in a deployment that runs only on public data, show what this guide builds.

<table>
<tr>
<td width="50%" valign="top">

https://github.com/user-attachments/assets/32fc1b20-5cf9-4ebe-9f29-826d875b63a6

<b>Fabric IQ, ontology and graph</b> (44 seconds). The ontology, the ontology agent answering a question in plain language, and the same question asked of the graph model with <a href="../ingestion-framework/queries/galilee-deepest-wells.gql">galilee-deepest-wells.gql</a>.
</td>
<td width="50%" valign="top">

https://github.com/user-attachments/assets/97233bb6-9d5f-42d5-9f87-5e8e8cdac7f7

<b>The ingestion framework</b> (27 seconds). The workspace, the ingest pipeline, its run history and one successful run: seven dataset copies, then three notebooks.
</td>
</tr>
</table>

The [product tour](SCREENSHOTS.md#microsoft-fabric) has a screenshot of each item.

## Tenant prerequisites

| Requirement | Who | Details |
|---|---|---|
| **Users can create Fabric items** and **Users can create Ontology (preview) items** | Fabric administrator | Tenant settings under OneLake catalog > Govern > Configurations ([required tenant settings for ontology](https://learn.microsoft.com/fabric/iq/ontology/overview-tenant-settings)) |
| **Service principals can call Fabric public APIs** | Fabric administrator | Needed because the app's Fabric identity reads the graph as a service principal. Limit it to a security group that holds that identity ([developer tenant settings](https://learn.microsoft.com/fabric/admin/service-admin-portal-developer#service-principals-can-call-fabric-public-apis)). |
| A capacity region that offers graph | Deployer | Graph in Fabric is available only in some regions ([region availability](https://learn.microsoft.com/fabric/graph/overview#region-availability)). |
| Tenant-wide admin consent for the app's sign-in registration | Global Administrator, once | Required for Fabric IQ. The ontology must also be published before Fabric IQ can reach it ([Fabric IQ admin management](https://learn.microsoft.com/azure/foundry/agents/how-to/tools/fabric-iq#admin-management)). |

## Capacity

The knowledge workspace needs a paid Fabric capacity.

- **Greenfield:** [fabric-capacity.bicep](../infra/bicep/agents/fabric-capacity.bicep) or [fabric.tf](../infra/terraform/fabric.tf) creates one.
- **Brownfield:** name an existing capacity with `GBX_FABRIC_CAPACITY_CREATE=false`.
- **Size:** an F8 comfortably runs the framework, graph reloads and Fabric IQ for a pilot. Smaller SKUs work with longer runs.
- **Administrators:** give user principal names for people and object IDs for service principals.

**Paused capacity.** Fabric content, including the ontology, the graph and Fabric IQ, is unavailable while its capacity is paused. Many organizations pause capacities overnight to save cost. The app degrades gracefully: knowledge cards come from the bundled snapshot and say so, and the scientists continue with search and the typed tools.

**Morning resume (optional).** To have the capacity running before people start work, deploy [fabric-resume.bicep](../infra/bicep/agents/fabric-resume.bicep) with `GBX_FABRIC_RESUME=true`. It is a small Logic App whose managed identity holds a custom role with only read and resume on that one capacity. It cannot pause, resize or delete it.

[fabric_capacity.py](../infra/scripts/fabric_capacity.py) shows the capacity's state, resumes it on demand and warms the graph with one small query. The first graph query after a resume can take about a minute.

## Workspace

`infra/scripts/deploy.sh fabric` creates the workspace named in `GBX_FABRIC_WORKSPACE_NAME` on the capacity, or reassigns an existing workspace with that name, and records its ID. It uses [fabric_workspace.py](../infra/scripts/fabric_workspace.py), which calls the Fabric REST API.

Brownfield deployments can set `GBX_FABRIC_WORKSPACE_ID` to a workspace they already own. Whoever runs the framework needs at least the Contributor role on the workspace.

## The six steps

The [ontology ingestion framework](../ingestion-framework) builds the knowledge model in six steps. You can verify each step on its own.

| Step | What happens |
|---|---|
| 1. Produce | **Producers** write each dataset as a folder: a `dataset.json` (title, description, priority) plus entity and relationship files with descriptions, synonyms, units and data types. |
| 2. Land and prepare | The framework copies every file into a raw schema in the lakehouse, expands JSON properties into typed columns, checks that every relationship points at real entities, and writes one table per entity type and one junction table per relationship type. |
| 3. Generate | It generates the ontology definition, publishes it through the Fabric REST API, then reads it back and checks it. |
| 4. Verify | It checks every table's row count against the plan. With `--mcp-smoke`, it also asks the ontology's MCP endpoint a question. |
| 5. Graph | It publishes a **graph model** over the same binding tables, reloads it and checks every node and edge count against the plan. |
| 6. Connect | It connects the ontology to a Foundry project as a Fabric IQ tool. |

`infra/scripts/deploy.sh knowledge` runs the whole build: it writes the framework's configuration from your settings, assembles the data bundle, runs the producers, runs the framework with an MCP smoke test, records the ontology and graph model IDs, and redeploys the agents' Foundry account so that its Fabric IQ connection points at the new ontology.

To run the same steps by hand:

```bash
cd ingestion-framework
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[delta,test]'
python tools/make_bundle.py --out ../build/bundle --wsm ../build/downloads/WSM_Database_2025.csv   # needs npm ci in app/
python -m producers --bundle ../build/bundle --out ../build/landing
python -m ontology_ingest --config config/geobasin.json run --mcp-smoke
python -m ontology_ingest --config config/geobasin.json graph --query-file queries/galilee-deepest-wells.gql
```

Each live run needs its own run ID, because a landed snapshot never changes. Runs are staged in their own schemas, so the previous run stays published for rollback. A retention setting removes old runs safely.

## The one manual step

A graph model defined through the REST API cannot load data until someone opens it once in the graph model editor in the Fabric portal ([manage data in graph](https://learn.microsoft.com/fabric/graph/manage-data)).

On a first build, `infra/scripts/deploy.sh knowledge` publishes the ontology and the graph model, recognizes this one stop, records both items and lets the deployment continue, so `deploy.sh all` finishes. The ontology and Fabric IQ work at once; the typed knowledge tools say the graph isn't connected until it loads. Open the new graph model once in the portal and run `infra/scripts/deploy.sh knowledge` again. Every later run reloads and checks the graph unattended.

The framework builds a separate graph model instead of using the ontology's built-in graph. Fabric marks entity types published through the public API as an unsupported data source for the built-in graph ([graph limitations](https://learn.microsoft.com/fabric/iq/ontology/how-to-use-ontology-graph#limitations)).

## Data bundle

The producers read a data bundle: the application packs, the curated knowledge-graph kit and well extractions generated from them, one public download and, optionally, the library's published manifest.

- [make_bundle.py](../ingestion-framework/tools/make_bundle.py) builds the bundle from this repository. It copies the app's packs, with withheld sources already removed, writes the well and seismic extractions from them, and generates the curated kit with the app's own graph code ([export-kits.ts](../tools/export-kits.ts)).
- The World Stress Map Database Release 2025 is downloaded by hand from its publisher. Set `GBX_WSM_CSV` to the downloaded file and the `knowledge` phase adds it.
- Once your library is published, the `knowledge` phase fetches its manifest from your site, so the knowledge model lists the same sources and documents.
- A producer whose input is missing is skipped with a clear message. Use `--strict` to make a missing input an error.

[KNOWLEDGE_INPUTS.md](../ingestion-framework/docs/KNOWLEDGE_INPUTS.md) describes every input and the node and edge counts to expect.

## Run as a Fabric pipeline

Steps 2 to 5 can also run inside Fabric as a Data Factory pipeline, with every step in the pipeline's run history:

1. `land` copies the files to the lakehouse's Files area.
2. A metadata-driven pipeline lists the dataset folders and copies every entity and relationship file into a raw table, with one child pipeline run per dataset.
3. Three notebooks expand the nested JSON into typed tables, publish the ontology with its bindings, and build the graph model.

```bash
python -m ontology_ingest --config config/geobasin.json --run-id run2 run --engine pipeline --mcp-smoke
```

Pipeline run IDs use lowercase letters, digits and underscores, up to 60 characters, because they become part of a schema name inside a pipeline expression. Both routes share the same code, produce the same tables, and can publish the next run ([REST API capabilities for pipelines](https://learn.microsoft.com/fabric/data-factory/pipeline-rest-api-capabilities), [Invoke pipeline activity](https://learn.microsoft.com/fabric/data-factory/invoke-pipeline-activity)).

## How the app and agents read the model

- **Agents** query the ontology through the Fabric IQ tool in the `gbx-knowledge` toolbox, as the signed-in user. The ontology's MCP endpoint answers only a user or an OAuth session ([ontology as an MCP server](https://learn.microsoft.com/fabric/iq/ontology/how-to-use-ontology-mcp-server)).
- **The tool server** reads the graph with its own Fabric identity, `id-gbx-site-fabric`. [grant-fabric-reader.sh](../infra/scripts/grant-fabric-reader.sh) gives it the Viewer role on the workspace and a OneLake security role, GeoBasinGraphReaders, with Read on exactly the tables the graph model reads.

The script reads those tables from the graph's definition on every run, so a graph republished to a new schema stays readable. OneLake applies a role change in about five minutes ([OneLake data access control](https://learn.microsoft.com/fabric/onelake/security/data-access-control-model#latencies)).

## Keep the definitions in Git

Fabric Git integration works with GitHub and Azure DevOps. It can version notebooks, pipelines, lakehouses and graph models, with ontologies in preview. For a long-lived deployment, keep the notebooks and the ontology definition under Git integration while the framework continues to publish the content. Changes to the knowledge model are then reviewed like code ([Fabric Git integration](https://learn.microsoft.com/fabric/cicd/git-integration/intro-to-git-integration)).

## Add your own data

To add a dataset, write a producer: a small Python module that reads your source and writes one dataset folder through `ontology_ingest.contract.DatasetWriter`, with descriptions, synonyms and units for each entity and relationship type.

On the next run, the framework discovers the new types, binds them and adds them to the ontology and the graph. The tests in `ingestion-framework/tests` show the contract in detail.

Proprietary data stays in your own tenant, governed by Fabric workspace roles and OneLake security. Fabric IQ continues to answer each user with their own permissions.
