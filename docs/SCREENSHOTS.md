# Product tour

These screenshots show GeoBasin Explorer AI as a user sees it, and the knowledge layer behind it in Microsoft Fabric. They come from a Microsoft-hosted deployment that runs only on public data. Your deployment shows your own brand pack and data.

**Contents:** [Videos](#videos) · [Start](#start) · [Map](#map) · [Ask](#ask) · [Knowledge](#knowledge) · [Images](#images) · [Co-Scientist](#co-scientist) · [Data](#data) · [Evaluate](#evaluate) · [Microsoft Fabric](#microsoft-fabric)

## Videos

Each video was recorded live and plays right here. When an agent takes longer than a few seconds, the wait is shortened and labeled on screen. The MP4 files are in the [media](media) folder.

<table>
<tr>
<td width="50%" valign="top">

https://github.com/user-attachments/assets/6307d614-a488-4707-baec-028fb49a66d2

<b>A 30-second tour.</b> A role, the map, a prepared answer, an answer written by a Microsoft Foundry agent, the knowledge graph, the Co-Scientist and image search.
</td>
<td width="50%" valign="top">

https://github.com/user-attachments/assets/b3ea6a45-6aa6-414a-8ef6-1ef486010dc7

<b>Ask, verify and see the work</b> (27 seconds). Two questions, their sources, the validator's result and the steps behind each answer, including the search and the agent call.
</td>
</tr>
<tr>
<td valign="top">

https://github.com/user-attachments/assets/32fc1b20-5cf9-4ebe-9f29-826d875b63a6

<b>Fabric IQ, ontology and graph</b> (44 seconds). The ontology, the ontology agent answering in plain language, and the same question asked of the graph model in GQL.
</td>
<td valign="top">

https://github.com/user-attachments/assets/97233bb6-9d5f-42d5-9f87-5e8e8cdac7f7

<b>The ingestion framework</b> (27 seconds). The workspace, the ingest pipeline, its run history and one successful run as a list and as a Gantt chart.
</td>
</tr>
</table>

## Start

**Choose a role.** Everyone sees the same public data. The role sets the starting view and suggests questions to try. You can switch roles at any time.

<img src="images/roles.webp" alt="Role picker with exploration geoscientist, program lead, data scientist and computational geoscientist roles" width="100%">

## Map

**Map workspace.** Four basins on Azure Maps, with layers, evidence and drawing tools. The copilot stays open beside the map.

<img src="images/map.webp" alt="Map workspace with the Cooper, Adavale, Galilee and North Bowen basins" width="100%">

**What we know here.** Click any point to see its depth to basin floor, data uncertainty, nearest boreholes and its position in GDA2020 and MGA. The GDAL/PROJ spatial service computes every distance and coordinate.

<img src="images/place.webp" alt="What we know here card for a point in the Cooper Basin" width="100%">

**Cross-sections.** Draw a line or pick a preset to get a computed section with boreholes and faults along it.

<img src="images/cross-section.webp" alt="West to east cross-section across the Cooper Basin" width="100%">

**Low-carbon lens.** Screen legacy wells for CO₂ storage and geothermal potential against published criteria. The temperature-at-depth layer shows where heat is highest.

<img src="images/low-carbon.webp" alt="Low-carbon screening panel and the temperature at 5 km layer" width="100%">

## Ask

**Copilot.** Ask a question in plain language. The reply lists its sources and how many statements the validator confirmed.

<img src="images/copilot.webp" alt="Copilot reply that ranks analog plays, with sources and validation status" width="100%">

**Cited answer.** Open the full answer to see each source, the related images and the places it mentions on the map.

<img src="images/hero.webp" alt="Full answer with sources, images and map features" width="100%">

**Show your work.** Every answer can show the steps that produced it, with the time each step took.

<img src="images/show-your-work.webp" alt="Answer panel with the steps that produced the answer" width="100%">

## Knowledge

**Stratigraphic framework.** Units, plays and resource flags by age, built from public framework tables. Click any box to open its card.

<img src="images/framework.webp" alt="Cooper Basin stratigraphic framework chart" width="100%">

**Entity card.** Each unit shows its properties, relationships, core images and where the data came from.

<img src="images/entity.webp" alt="Patchawarra Formation card with relationships and core images" width="100%">

**Knowledge graph.** Explore an entity and its neighbors. The same graph model lives in Microsoft Fabric.

<img src="images/knowledge-graph.webp" alt="Graph view centered on the Patchawarra Formation" width="100%">

**Ontology.** Entity types, relationship types, counts and the source of every link. You can download the ontology as Turtle.

<img src="images/ontology.webp" alt="Ontology schema with entity and relationship types" width="100%">

## Images

**Image search.** Find core photos and panels that look alike, each linked to its unit, play and well.

<img src="images/image-search.webp" alt="Core images ranked by look-alike similarity" width="100%">

## Co-Scientist

**Test a hypothesis.** Pick a statement or write your own. Specialist agents (literature, stratigraphy, spatial, rock, stress) gather evidence. A critic reviews the draft. The verdict counts the evidence for, against and missing, and you make the call.

<img src="images/co-scientist.webp" alt="Co-Scientist result with specialist agents, verdict and critic" width="100%">

## Data

**What's real.** Every item on screen is labeled as real, computed, extracted or illustrative, with its source.

<img src="images/data.webp" alt="Data sheet listing what is real and where it came from" width="100%">

**Loading.** Counts and timings for every document, page and extracted value.

<img src="images/loading.webp" alt="Loading tab with document, page and extraction counts" width="100%">

**Governance.** Lineage for every item, plus the license and credit that travel with each source.

<img src="images/governance.webp" alt="Governance tab with lineage steps and the license table" width="100%">

## Evaluate

**Scorecard.** A benchmark of scientist questions with answer keys. Ask each question, check its sources, mark the result and export the scorecard to Excel.

<img src="images/evaluate.webp" alt="Evaluation scorecard with the benchmark questions" width="100%">

## Microsoft Fabric

The [ingestion framework](FABRIC_KNOWLEDGE.md) builds everything in this section from public data. Names that would identify the hosting tenant are hidden in these screenshots.

**Workspace.** One Fabric workspace holds the lakehouse, the notebooks, the pipelines, the ontology and the graph model.

<img src="images/fabric-workspace.webp" alt="Fabric workspace listing the graph model, ontology, pipelines, notebooks and lakehouse" width="100%">

**Ontology.** 30 entity types, such as Basin, Wellbore and StratigraphicUnit, and 53 relationship types, each bound to tables in the lakehouse. The neighborhood view shows one entity type and the types it links to.

<img src="images/fabric-ontology.webp" alt="Ontology editor showing the neighborhood of the StratigraphicUnit entity type" width="100%">

**Ontology agent.** Ask the ontology a question in plain language. The answer is grounded in the ontology's definitions and bindings. In Plan mode, the agent makes no changes to the ontology or the workspace ([use the ontology agent](https://learn.microsoft.com/fabric/iq/ontology/how-to-use-ontology-agent)).

<img src="images/fabric-iq-agent.webp" alt="Ontology agent answering with the five deepest wells in the Galilee Basin" width="100%">

**Graph query builder.** The graph model holds the same knowledge as 30 node types and 53 edge types. The query builder starts from any node type ([how graph in Microsoft Fabric works](https://learn.microsoft.com/fabric/graph/how-graph-works)).

<img src="images/fabric-graph-builder.webp" alt="Graph query builder offering every node type of the graph model" width="100%">

**GQL.** The query in [galilee-deepest-wells.gql](../ingestion-framework/queries/galilee-deepest-wells.gql), run in the code editor, returns the same five wells as the ontology agent ([query the graph with GQL](https://learn.microsoft.com/fabric/graph/tutorial-query-code-editor)).

<img src="images/fabric-graph-gql.webp" alt="GQL query and its result: the five deepest wells in the Galilee Basin" width="100%">

**Ingestion pipeline.** The pipeline checks the run ID and lists the dataset folders. It copies each dataset in its own child pipeline run, then three notebooks expand the JSON into tables, publish the ontology with its bindings and build the graph model.

<img src="images/fabric-pipeline.webp" alt="Ingest pipeline with its condition, metadata, filter, for-each and notebook activities" width="100%">

**A pipeline run.** All 14 activities of one run succeeded in about 14 minutes: seven dataset copies, then the three notebooks.

<img src="images/fabric-pipeline-run.webp" alt="Pipeline run details with every activity run and its duration" width="100%">

**Gantt view.** The same run on a timeline ([monitor pipeline runs](https://learn.microsoft.com/fabric/data-factory/monitoring-hub-pipeline-runs)).

<img src="images/fabric-pipeline-gantt.webp" alt="Gantt chart of the activity runs in one pipeline run" width="100%">
