"""Upstream producers for the GeoBasin use case: step 1 of the ingestion workflow.

Each producer turns one source in the workspace into a dataset folder that follows the framework's contract
(entities/<Type>.csv, relationships/<name>.csv, dataset.json). The framework never needs to know how a producer
read its source; any other use case can plug in its own producers, for example a document-extraction service.
"""

PRODUCERS = ("kit", "ga_basins", "app_pack", "well_reports", "oztemp", "wsm", "sources")
