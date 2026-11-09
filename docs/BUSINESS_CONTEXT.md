# Business context

This guide explains the problem GeoBasin Explorer AI solves, why it matters now, who it serves and how it uses multimodal AI on Azure. It is for business and technical readers. [ARCHITECTURE.md](ARCHITECTURE.md) and [DEPLOYMENT.md](DEPLOYMENT.md) cover the engineering.

## The problem

Subsurface work in oil, gas and new energy depends on data that was never designed for machines to read.

- **Decades of drilling history.** A single basin can hold 70 years of wells. Most of what each well taught us lives in its completion report: often a scanned typescript with handwritten notes, fold-out logs, lab sheets and units that change partway through, from feet and Fahrenheit to meters and Celsius.
- **Many publishers, many formats.** Regional geology, horizons, temperature, stress, airborne geophysics and geodetic standards come from different agencies. Each uses its own format, coordinate reference system and license.
- **Slow, fragile preparation.** Before interpretation, teams find the material, read it page by page, reconcile depths quoted against different datums, copy values into spreadsheets and try to remember where each number came from.
- **Knowledge that walks out the door.** What people learn stays in personal notes and slides, not in a shared model the next team can build on.

The same data now faces new questions:

- **CO₂ storage.** Every old wellbore near a storage site is a possible leak path. Its casing, cement and abandonment records must be found and trusted.
- **Geothermal.** Developers need temperature gradients and heat-flow data that were often recorded only in passing.
- **Hydrogen, helium and critical minerals.** Exploration starts from the same well files and basin studies.

These questions often come from teams who did not create the data and cannot spend months preparing it before they know whether an opportunity is worth pursuing.

## Why now

| Trend | Effect |
|---|---|
| The energy transition needs faster screening | Portfolios of storage sites, geothermal prospects and late-life assets must be ranked quickly and cheaply. Data preparation often costs more than the answer is worth. |
| Multimodal AI is ready | Models can now read scanned documents, tables, figures and photos with useful accuracy, extract values with a stated confidence, and reason over them. |
| Ungoverned AI is a liability | Regulators, partners and boards expect AI-assisted conclusions to show their evidence, respect licenses and access rights, and keep an expert in charge. |

GeoBasin Explorer AI answers all three: it cuts weeks of preparation to minutes, uses multimodal models where they help, and makes every answer traceable, validated and governed.

## Business drivers

| Driver | What it means |
|---|---|
| Faster time to insight | Screen a basin or a portfolio in days, not months. |
| Reuse of legacy data | Put decades of public and proprietary records to work on today's questions. |
| Trust and auditability | Trace every statement to its page, figure or dataset row, checked by an independent validator. |
| Knowledge retention | Capture what experts learn in a shared ontology and graph, not in personal files. |
| License and access compliance | Honor each source's reuse terms and each user's permissions automatically. |
| Cost and capacity discipline | Use limits, budgets and a kill switch, and pause expensive capacity without losing the answer path. |
| Sovereignty and governance | Keep agents, conversations and data in your own tenant and subscription, with lineage from source to answer. |

## Audiences

| Audience | What they do | What they gain |
|---|---|---|
| Exploration and production geoscientists, petrophysicists, reservoir engineers (primary users) | Ask about basins, formations, wells and plays; check answers on the map and in the knowledge graph; open the exact page behind each statement; export results with citations | Time back for interpretation, and an evidence trail they can defend in peer review |
| CO₂ storage, geothermal and new-energy teams | Screen sites against published criteria (depth, pressure headroom, permeability, salinity) and review the integrity of nearby legacy wells | New value from old data, and a clear view of where evidence is thin |
| Research leads and program managers | Test hypotheses with the Co-Scientist and record verdicts with reasons | A structured, recorded way to decide what to pursue next, with dissent preserved |
| Subsurface data managers and data scientists | Register sources, approve extractions, run the ingestion framework and evaluate answer quality | A repeatable, metadata-driven path from mixed data to governed tables, an ontology and a graph |
| Cloud architects, platform and security engineers | Deploy and operate the platform | A reference implementation in Bicep and Terraform with private data stores, managed identities, a web application firewall, malware scanning, budgets and alerts |
| Executives and sponsors | Sponsor and measure the program | Lower screening time and cost, better reuse of data, and AI that is grounded and governed |
| Microsoft and partner field teams | Demonstrate the solution | A working demo in a customer's own tenant, on real public data |

## Use cases

| Scenario | What the system does |
|---|---|
| A new-ventures team screens an unfamiliar basin | Gives a cited summary of proven reservoirs, the deepest wells and the regional stress regime, with a map of the wells and a graph of the stratigraphy. Every report page behind it is one click away. |
| A CO₂ storage team evaluates a depleted field | Finds casing, cement and completion records for every legacy well near the injection site, flags low-confidence values for review, and shows where no plug-and-abandon record exists. |
| A geothermal developer compiles temperature evidence | Combines interpolated temperature at depth with bottom-hole temperatures read from well reports, and shows where the two disagree. |
| A data manager adds a new public survey | Registers the source; the live lane fetches, verifies, scans and reads it; the manager reviews and publishes it. It is then searchable, mapped and available to the agents with its license. |
| A research lead tests an analog hypothesis | Records a "needs more data" verdict with the specific missing evidence, which becomes the next work item. |

## How multimodal AI on Azure helps

| Capability | Azure service | Result |
|---|---|---|
| Read scanned and digital reports, tables and layout | Azure Document Intelligence | Values extracted with their page and position |
| Interpret figures, logs and core photos | Vision-capable models in Microsoft Foundry | Image readings shown beside the original, so people can check them |
| Find evidence by meaning and by place | Embeddings and Azure AI Search | Hybrid, vector and geo search over passages, pages and figures |
| Model how basins, formations, wells and plays relate | Microsoft Fabric ontology and graph | A shared knowledge model that agents query through Fabric IQ with each user's permissions |
| Divide the reasoning like a team of scientists | Microsoft Foundry Agent Service and Microsoft Agent Framework | Specialist agents, a critic and a lead |
| Pick the right model for each step | Foundry model router | An approved list of models, with failover |
| Check every statement | A validator model from a different model family | Unsupported statements removed and shown as removed |

The discipline around these capabilities is what makes the results trustworthy:

- every answer cites its evidence;
- the system says "Not found" when the evidence is silent;
- experts approve extractions and record decisions;
- licenses and access rights are enforced automatically;
- the platform runs in your own tenant with private data stores and managed identities.

## Measures of success

Any deployment can track these outcomes:

- **Answer quality.** Answers cite the expected source and key facts for a benchmark of questions with known answers. The evaluation workspace reports both.
- **Validation.** Every published statement passes independent validation. The share of "Validation incomplete" answers is visible.
- **Speed.** Screening a basin or a site takes hours, not weeks.
- **Extraction quality.** Every extracted value carries a confidence. Low-confidence values wait for expert review, and the review queue is visible.
- **Cost.** Model spend stays within the budgets and limits set for the deployment, with alerts before limits are reached.

## The data in this edition

This edition uses only public data from Australian and New Zealand agencies and international compilations. [DATA_SOURCES.md](DATA_SOURCES.md) lists each source and its license.

The same framework accepts your proprietary data:

- new producers for the ingestion framework;
- new sources in the live lane's registry;
- new brand packs for the interface.

A deployment can grow from this public demonstration into a working tool over your own records, inside your own tenant and governance.
