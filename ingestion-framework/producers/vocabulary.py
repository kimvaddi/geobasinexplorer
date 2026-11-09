"""Plain-language descriptions and synonyms for the GeoBasin entity types, relationships and key properties.

Producers attach these to dataset.json, and the framework carries them into the ontology as TMDL descriptions and
synonyms, which is what the ontology agent and the Foundry agent read when they map a question to the schema.
"""

ENTITIES: dict[str, tuple[str, list[str]]] = {
    "Basin": ("A sedimentary basin or geological province from the Geoscience Australia basin packages, with its age, area, depth to the basin floor, and counts of the boreholes, faults, seismic lines and stress records that fall inside it. Named troughs, depressions, depocentres, folds and faults inside a basin are StructuralElement records linked to it by locatedIn, and they carry the basin-floor depths for those features. To find wells, structures or measurements inside a basin, follow the locatedIn relationship.", ["basin", "sedimentary basin", "province", "basin package"]),
    "Wellbore": ("A drilled well or borehole, whether petroleum, stratigraphic, coal, coal seam gas, water or mineral, with its position, total depth in metres, completion year, type, operator, result and whether it lies inside a basin outline. The locatedIn relationship links each well to every basin whose outline contains it.", ["well", "borehole", "bore", "drillhole", "drill hole"]),
    "StratigraphicUnit": ("A named rock unit such as a formation, member, group or supergroup, with its age (youngest and oldest in millions of years), lithology, depositional environment, petroleum-system role, unconventional resource flag and hydrostratigraphy.", ["formation", "rock unit", "member", "group", "stratigraphic unit"]),
    "PlayInterval": ("A petroleum play interval, meaning a slice of the basin succession whose rocks share reservoir, seal and source roles, with its age range in millions of years, period, lithology, depositional environment and resource flags.", ["play", "play interval", "petroleum play"]),
    "StructuralElement": ("A named structural feature or depocentre inside a basin, such as a trough, depression, syncline, anticline, ridge, shelf, block or fault. basin_floor_max_m, basin_floor_mean_m and basin_floor_p90_m give the feature's depth to the basin floor, taken from the depocentre zone centred on its deepest part when it has one; label_point_floor_* and depocentre_* keep the two underlying measurements.", ["structure", "structural feature", "trough", "depocentre", "depression", "fold", "syncline", "anticline"]),
    "CoreImage": ("A photograph, panel or strip of drill core, with the well it came from, the depth range, and the formation and play interval it shows.", ["core photo", "core image", "core panel", "core strip"]),
    "StratigraphicChart": ("A Geoscience Australia stratigraphic framework chart for one basin package.", ["stratigraphic chart", "framework chart"]),
    "Document": ("A source document: basin data guides, glossaries, reference lists and metadata records, scanned well completion reports with their appendices and enclosures, and documents in the GeoBasin library, with page counts.", ["document", "report", "publication", "source document"]),
    "PetroleumRole": ("A petroleum-system role that a rock unit can play, such as reservoir, seal or source rock.", ["petroleum role", "reservoir", "seal", "source rock"]),
    "ResourceFlag": ("An unconventional resource flag from the Geoscience Australia framework tables, such as tight gas, shale gas or coal seam gas prospectivity.", ["resource flag", "tight gas", "shale gas", "coal seam gas", "unconventional resource"]),
    "HydroInterval": ("A hydrostratigraphic interval, meaning a grouping of rock units into an aquifer or aquitard.", ["aquifer", "aquitard", "hydrostratigraphic interval"]),
    "Hypothesis": ("A prepared geological hypothesis that the explorer tests by counting the cited evidence for and against it.", ["hypothesis", "test"]),
    "EvidencePassage": ("A passage of text from a source document, identified by document, page and heading, that answers can cite as evidence.", ["passage", "excerpt", "text", "evidence"]),
    "Dataset": ("A geospatial or tabular dataset file in a basin package, such as a shapefile layer, a GeoTIFF grid or a report, with its format, record count, coordinate reference system and licence.", ["dataset", "layer", "data file"]),
    "SeismicLine": ("A segment of a 2D seismic survey line from the Geoscience Australia seismic coverage, with its end points and length in kilometres.", ["seismic line", "2D seismic", "seismic survey line"]),
    "Figure": ("An interpreted figure from a scanned report, for example a seismic time section, with its caption and the values read from it.", ["figure", "seismic section", "illustration"]),
    "DataQualityFinding": ("A data-quality issue found while cross-checking sources, such as a name mismatch, a value conflict or a metadata error.", ["data quality issue", "finding", "discrepancy"]),
    "ValidationCheck": ("A check that recomputes a published claim from the data and records whether the claim matches.", ["validation", "check"]),
    "WellPosition": ("One recorded surface position of a well from a specific source and datum, with its distance from the Geoscience Australia position.", ["well position", "well location", "coordinates"]),
    "ExtractedField": ("A value read from a scanned well report or enclosure by vision or OCR, with the page, the supporting quote, a confidence rating and whether it needs review.", ["extracted value", "report field", "field"]),
    "ReportFinding": ("A finding stated in a well report, for example about reservoir quality, hydrocarbons, temperature or well integrity, with the supporting quote and page.", ["report finding", "well finding"]),
    "TemperatureMeasurement": ("A subsurface temperature measured at a depth, for example a bottom-hole temperature, an equilibrium log or a drill-stem test, from the OzTemp database or a well temperature log.", ["temperature", "bottom hole temperature", "BHT", "geothermal measurement"]),
    "PressureMeasurement": ("A downhole pressure reading at a depth from a pressure-temperature survey in a well.", ["pressure", "downhole pressure", "PTS pressure"]),
    "WellLog": ("A digitised downhole curve from a well report or log file, such as a temperature log, a bottom-hole temperature table or a pressure-temperature survey, with its unit, source document and digitising notes.", ["well log", "log curve", "temperature log", "PTS survey"]),
    "CheckshotReading": ("One shot from a well velocity (checkshot) survey, with depths, travel times and the interval velocity.", ["checkshot", "velocity survey shot", "shot record"]),
    "TimeDepthPoint": ("A point on a well's time-depth curve: depth below mean sea level and two-way travel time.", ["time-depth point", "T-Z point"]),
    "LowCarbonProject": ("A carbon capture and storage or geothermal project, with facts taken from its published sources.", ["CCS project", "carbon storage project", "low-carbon project"]),
    "StressMeasurement": ("An in-situ stress indicator from the World Stress Map 2025 release, with the azimuth of the maximum horizontal stress, the stress regime, the quality rank, the depth and the method. Quality runs from A (best) to E; E records have no reliable orientation. Regime U means the regime is unknown, so it is not a regime: leave U records out when asked for the dominant regime, or use the basin's dominant_stress_regime. Every Australian record is kept, so counts here include E-quality and unknown-regime records.", ["stress measurement", "stress indicator", "SHmax", "World Stress Map record"]),
    "Source": ("A licensed source package or publication in the GeoBasin library, with its publisher, licence, attribution text and its document, page and chunk counts.", ["source", "source package", "publication"]),
    "SourceFile": ("A file in the GeoBasin data bundle together with its provenance: the original source, download URL, publisher, licence, checksum and how GeoBasin uses it.", ["source file", "bundle file", "provenance record"]),
}

RELATIONS: dict[str, tuple[str, list[str]]] = {
    "belongsToBasin": ("The rock unit or play interval belongs to the basin or province.", ["belongs to", "part of basin"]),
    "mappedIn": ("The rock unit is mapped in the basin package, so it appears in that package's stratigraphic framework.", ["mapped in"]),
    "isPartOf": ("The rock unit is part of a larger unit, for example a member of a formation or a formation of a group.", ["part of", "subunit of"]),
    "assignedToPlay": ("The rock unit is assigned to the play interval.", ["in play", "assigned to play"]),
    "hasResourceFlag": ("The rock unit carries the unconventional resource flag.", ["has resource flag"]),
    "hasRole": ("The rock unit plays the petroleum-system role, for example reservoir or seal.", ["has role", "acts as"]),
    "inHydroInterval": ("The rock unit belongs to the hydrostratigraphic interval.", ["in aquifer", "in hydro interval"]),
    "shownOn": ("The rock unit is shown on the stratigraphic chart.", ["shown on"]),
    "depictsUnit": ("The core image shows the rock unit.", ["shows unit"]),
    "depictsPlay": ("The core image shows the play interval.", ["shows play"]),
    "fromBorehole": ("The core image comes from the well.", ["from well"]),
    "partOfPanel": ("The core strip is part of the core panel.", ["part of panel"]),
    "locatedIn": ("The feature, well, measurement or project lies inside the basin outline.", ["located in", "inside", "in basin"]),
    "describes": ("The document or chart describes the basin.", ["describes", "covers"]),
    "reportFor": ("The document is a report for the well.", ["report for", "well report"]),
    "tests": ("The hypothesis tests the play, basin, unit or well.", ["tests", "evaluates"]),
    "aboutBasin": ("The passage is about the basin.", ["about basin"]),
    "aboutWell": ("The passage, finding, figure or extracted value is about the well.", ["about well"]),
    "fromDocument": ("The passage, figure, finding or extracted value was taken from the document.", ["from document", "cited from"]),
    "evidencedBy": ("The play interval is supported by the evidence passage.", ["evidenced by", "supported by"]),
    "coversBasin": ("The dataset or source covers the basin.", ["covers basin"]),
    "positionOf": ("The recorded position belongs to the well.", ["position of"]),
    "measuredIn": ("The measurement was taken in the well.", ["measured in", "recorded in"]),
    "partOfLog": ("The reading is one point of the well log curve.", ["part of log", "point of curve"]),
    "partOfSource": ("The document belongs to the source package.", ["part of source"]),
    "fileOfSource": ("The bundle file belongs to the source package.", ["file of source"]),
}

PROPERTIES: dict[str, dict[str, dict]] = {
    "Basin": {
        "area_km2": {"description": "Area of the basin outline in square kilometres.", "unit": "km2"},
        "depth_min_m": {"description": "Shallowest depth to the basin floor in metres from the Geoscience Australia package statistics on the full-resolution depth grid (negative means above sea level).", "unit": "m"},
        "depth_max_m": {"description": "Deepest depth to the basin floor in metres from the Geoscience Australia package statistics on the full-resolution depth grid.", "unit": "m"},
        "basin_floor_min_m": {"description": "Shallowest depth to the basin floor in metres on the resampled depth grid that the GeoBasin map uses.", "unit": "m"},
        "basin_floor_max_m": {"description": "Deepest depth to the basin floor in metres on the resampled depth grid that the GeoBasin map uses.", "unit": "m"},
        "boreholes_in_the_layer": {"description": "Number of boreholes in the basin package's borehole layer, whether inside or outside the basin outline."},
        "boreholes_inside": {"description": "Number of boreholes inside the basin outline."},
        "boreholes_deeper_than_1000m": {"description": "Number of boreholes inside the outline deeper than 1,000 m."},
        "boreholes_deeper_than_2000m": {"description": "Number of boreholes inside the outline deeper than 2,000 m."},
        "boreholes_reaching_base": {"description": "Number of boreholes that reach the base of the basin."},
        "dominant_stress_regime": {"description": "Dominant stress regime of the basin: the most common regime among the World Stress Map records of quality A to C with a known regime inside the outline (NF normal, SS strike-slip, TF thrust), as computed for the GeoBasin map. Quote this when asked for a basin's dominant stress regime."},
        "mean_shmax_azimuth_deg": {"description": "Mean azimuth of the maximum horizontal stress from the A to C quality records inside the outline, in degrees."},
        "stress_records_inside": {"description": "Number of World Stress Map records of quality A to D that have an orientation and lie inside the basin outline, as computed for the GeoBasin map; the StressMeasurement records linked by locatedIn also include E-quality and orientation-less records."},
        "stress_records_a_to_c_inside": {"description": "Number of World Stress Map records of quality A to C with an orientation inside the basin outline."},
        "published_area": {"description": "Area as published in the basin's data guide, with its geographic extent in words."},
        "maximum_depth_to_base": {"description": "Maximum depth to the base of the basin as published in the basin's data guide."},
    },
    "Wellbore": {
        "total_depth_m": {"description": "Total depth of the well in metres; for wells with a scanned completion report this is the value read from the report, otherwise the borehole layer value.", "unit": "m", "dataType": "double"},
        "year": {"description": "Year recorded for the well in the Geoscience Australia borehole layer; for wells with a scanned report, spud_year gives the year stated in the report itself.", "dataType": "int64"},
        "spud_year": {"description": "Year the well was spudded, as stated in its completion report.", "dataType": "int64"},
        "type": {"description": "Borehole type in lower case: petroleum, stratigraphic, coal, coal seam gas, water, mineral or unknown."},
        "operator": {"description": "Operator or report author company."},
        "result": {"description": "Well result recorded in the borehole layer, for example gas, oil and gas, or no hydrocarbons."},
        "inside_basin_outline": {"description": "True when the well lies inside at least one of the four basin outlines; to select wells inside one particular basin, follow the locatedIn relationship or check basins_inside.", "dataType": "boolean"},
        "major": {"description": "True for wells that Geoscience Australia marks as major or key wells.", "dataType": "boolean"},
        "basin_packages": {"description": "Basin packages whose borehole layer lists the well, comma separated; a package can list wells outside its own outline."},
        "basins_inside": {"description": "Basins whose outline contains the well, comma separated (cooper, adavale, galilee, northbowen); the same membership as the locatedIn relationship."},
        "ga_layer_records": {"description": "Package and record index of every borehole-layer record merged into this well."},
    },
    "StratigraphicUnit": {
        "age_top_ma": {"description": "Youngest age of the unit in millions of years.", "unit": "Ma", "dataType": "double"},
        "age_base_ma": {"description": "Oldest age of the unit in millions of years.", "unit": "Ma", "dataType": "double"},
    },
    "PlayInterval": {
        "age_top_ma": {"description": "Youngest age of the play interval in millions of years.", "unit": "Ma", "dataType": "double"},
        "age_base_ma": {"description": "Oldest age of the play interval in millions of years.", "unit": "Ma", "dataType": "double"},
    },
    "StructuralElement": {
        "basin_floor_max_m": {"description": "Deepest depth to the basin floor in metres for this feature: inside the depocentre zone centred on its deepest part when the feature has one, otherwise within basin_floor_radius_km of its label point (see basin_floor_basis). This is the depth to quote for how deep a trough, depression or depocentre is.", "unit": "m", "dataType": "double"},
        "basin_floor_mean_m": {"description": "Mean depth to the basin floor in metres for this feature, on the same basis as basin_floor_max_m.", "unit": "m", "dataType": "double"},
        "basin_floor_p90_m": {"description": "90th percentile depth to the basin floor in metres for this feature, on the same basis as basin_floor_max_m.", "unit": "m", "dataType": "double"},
        "basin_floor_radius_km": {"description": "Radius in kilometres of the area the basin_floor statistics cover.", "unit": "km", "dataType": "double"},
        "basin_floor_basis": {"description": "Which area the basin_floor statistics describe: the depocentre zone centred on the deepest part of the feature, or the circle around the feature's label point."},
        "label_point_floor_max_m": {"description": "Deepest basin-floor depth in metres within label_point_radius_km of the feature's label point (the annotation position), which can lie away from the deepest part of the feature.", "unit": "m", "dataType": "double"},
        "label_point_floor_mean_m": {"description": "Mean basin-floor depth in metres within label_point_radius_km of the feature's label point.", "unit": "m", "dataType": "double"},
        "label_point_floor_p90_m": {"description": "90th percentile basin-floor depth in metres within label_point_radius_km of the feature's label point.", "unit": "m", "dataType": "double"},
        "label_point_floor_min_m": {"description": "Shallowest basin-floor depth in metres within label_point_radius_km of the feature's label point.", "unit": "m", "dataType": "double"},
        "label_point_radius_km": {"description": "Radius in kilometres around the label point used for the label_point_floor statistics.", "unit": "km", "dataType": "double"},
        "depocentre_max_depth_m": {"description": "Deepest depth to the basin floor in metres inside the depocentre zone, which is centred on the deepest part of the feature.", "unit": "m", "dataType": "double"},
        "depocentre_mean_depth_m": {"description": "Mean depth to the basin floor in metres inside the depocentre zone centred on the deepest part of the feature.", "unit": "m", "dataType": "double"},
        "depocentre_p90_depth_m": {"description": "90th percentile depth to the basin floor in metres inside the depocentre zone centred on the deepest part of the feature.", "unit": "m", "dataType": "double"},
        "depocentre_area_km2": {"description": "Area of the depocentre zone in square kilometres.", "unit": "km2", "dataType": "double"},
        "depocentre_radius_km": {"description": "Radius of the depocentre zone in kilometres.", "unit": "km", "dataType": "double"},
        "depocentre_boreholes": {"description": "Number of boreholes inside the depocentre zone."},
        "fold_axis_length_km": {"description": "Length of the mapped fold axis in kilometres.", "unit": "km", "dataType": "double"},
        "type": {"description": "Kind of structure, for example Trough, Depression, Syncline, Anticline, Ridge, Shelf, Block, Fault or Depocentre."},
    },
    "StressMeasurement": {
        "azimuth_deg": {"description": "Azimuth of the maximum horizontal stress in degrees from north (null when the record has no orientation).", "dataType": "int64"},
        "quality": {"description": "World Stress Map quality rank from A (best) to E; E means no reliable orientation."},
        "regime": {"description": "Stress regime: NF normal faulting, NS normal to strike-slip, SS strike-slip, TS thrust to strike-slip, TF thrust faulting, U unknown. U is not a regime and should be left out when finding the dominant regime."},
        "depth_km": {"description": "Depth of the measurement in kilometres.", "unit": "km", "dataType": "double"},
    },
    "TemperatureMeasurement": {
        "depth_m": {"description": "Depth of the measurement in metres.", "unit": "m", "dataType": "double"},
        "temperature_c": {"description": "Measured temperature in degrees Celsius.", "unit": "C", "dataType": "double"},
    },
    "PressureMeasurement": {
        "depth_m": {"description": "Measured depth of the reading in metres.", "unit": "m", "dataType": "double"},
        "pressure_mpa": {"description": "Downhole pressure in megapascals.", "unit": "MPa", "dataType": "double"},
    },
}


COMMON: dict[str, dict] = {
    "package_id": {"description": "Short id of the Geoscience Australia basin package whose layer or table lists this record (cooper, adavale, galilee or northbowen). It does not mean the record lies inside that basin's outline; use the locatedIn relationship for that."},
    "lon": {"description": "Longitude in decimal degrees (GDA94).", "dataType": "double"},
    "lat": {"description": "Latitude in decimal degrees (GDA94); negative values are south of the equator.", "dataType": "double"},
    "crs": {"description": "Coordinate reference system of the recorded position."},
    "source_title": {"description": "Title of the source the record was taken from."},
    "source_id": {"description": "Identifier of the source the record was taken from, such as a Geoscience Australia catalogue (eCat) number."},
    "publisher": {"description": "Publisher of the source."},
    "licence": {"description": "Licence under which the source is published."},
}


def entity_type(writer, name: str, **extra) -> None:
    desc, syn = ENTITIES[name]
    writer.entity_type(name, description=desc, synonyms=syn, properties={**COMMON, **PROPERTIES.get(name, {})}, **extra)


def relationship_type(writer, name: str) -> None:
    desc, syn = RELATIONS[name]
    writer.relationship_type(name, description=desc, synonyms=syn)
