# Data sources

All data in GeoBasin Explorer AI comes from public sources. Every source carries its publisher, license and attribution into each citation, map layer and export.

| Record | Location |
|---|---|
| Bundled datasets (machine-readable) | [data/sources/manifest.csv](../data/sources/manifest.csv) |
| Live library, with each file's pinned checksum and the basis on which its license was confirmed | [services/api/src/live/pipeline-registry.ts](../services/api/src/live/pipeline-registry.ts) |
| Required attributions | [NOTICE.md](../NOTICE.md) |

## How sources are governed

A source enters the platform in one of two ways:

1. **Curated datasets** (used to build the app and the knowledge model) are listed in the source manifest with their publisher, license, attribution, link and files.
2. **Live library documents** are registered with a pinned checksum, a recorded license basis and an attribution. They are fetched from their publisher, verified, scanned and read, and they are published only after an expert approves the extraction.

**License gate.** The build withholds any source whose reuse terms are not confirmed, together with every value derived from it. Neither the bundled data nor any answer redistributes such content. Three public documents used during development are withheld for this reason and are not in this repository: two Geological Survey of Queensland open-file well reports, and a 2026 core workshop presentation from the Department for Energy and Mining of South Australia.

Organizations that deploy the platform are responsible for confirming that their use of each source, and of any source they add, complies with its terms.

## Bundled datasets

| Source | Publisher | License | Link |
|---|---|---|---|
| GEOLOGY: Cooper Basin region (TEGI data package, eCat 147461) | Geoscience Australia | CC BY 4.0 | https://doi.org/10.26186/147461 |
| GEOLOGY: Adavale Basin region (TEGI data package, eCat 147462) | Geoscience Australia | CC BY 4.0 | https://doi.org/10.26186/147462 |
| GEOLOGY: Galilee Basin region (TEGI data package, eCat 147460) | Geoscience Australia | CC BY 4.0 | https://doi.org/10.26186/147460 |
| GEOLOGY: North Bowen Basin region (TEGI data package, eCat 147459) | Geoscience Australia | CC BY 4.0 | https://doi.org/10.26186/147459 |
| Marabooka 1 well completion report and enclosures | Department for Energy and Mining, South Australia (PEPS SA) | CC BY 4.0 | https://peps.sa.gov.au/ |
| Habanero 1 well files (PTS logs and downhole diagrams) | Department for Energy and Mining, South Australia (PEPS SA) | CC BY 4.0 | https://peps.sa.gov.au/ |
| OzTemp interpreted temperature at 5 km and well temperature data (Gerner and Holgate) | Geoscience Australia | CC BY 3.0 AU | https://www.ga.gov.au/ |
| World Stress Map Database Release 2025 | GFZ German Research Centre for Geosciences | CC BY 4.0 (confirm on the release page) | https://doi.org/10.5880/WSM.2025.001 |
| Natural Earth land, coastline, states and shaded relief | Natural Earth | Public domain | https://www.naturalearthdata.com/ |
| Moomba Carbon Capture and Storage (public web page) | Santos | Short facts with a link only; no content redistributed | https://www.santos.com/moombaccs/ |

What each dataset provides:

- **Geoscience Australia basin packages** (from the Trusted Environmental and Geological Information program): regional geology, stratigraphy, play intervals, interpreted surfaces and borehole records for four basins in Queensland and South Australia.
- **PEPS SA well files:** legacy well completion records, read with Document Intelligence and vision models, including casing, cement, completion, temperature and pressure data.
- **OzTemp:** interpreted temperatures at depth and well temperature measurements for geothermal screening.
- **World Stress Map:** regional stress orientations and regimes.

## Live library

The live lane serves public documents and catalog records from four publishers. The registry records each publisher's terms.

| Publisher | License | Documents |
|---|---|---|
| Geoscience Australia | CC BY 4.0, © Commonwealth of Australia (Geoscience Australia) | The four TEGI basin packages; the 2019 Australian National Gravity Grids and explanatory notes, the isostatic residual gravity grids and the Australian National Gravity Database; AusAEM airborne electromagnetic surveys of the Eastern and Western Resources Corridors, with their data release summaries and the probabilistic inversion of the 20-kilometer AusAEM data; regional TEMPEST AEM surveys at Honeysuckle Creek (Victoria) and the Lower Macquarie River (New South Wales), and the River Murray Corridor AEM mapping survey, each with acquisition and processing reports, inversions and GIS user guides; high-resolution conductivity mapping from regional AEM and machine learning (Wilford and others, 2022); interpretations of seismic and potential-field data over the Capel and Faust basins; the 2016 Lord Howe Rise bathymetry survey; and the matching catalog records from Geoscience Australia's eCat. Each is cited with its eCat or record number. |
| Toitū Te Whenua Land Information New Zealand | CC BY 4.0 | Geodetic standards for New Zealand Geodetic Datum 2000 (LINZS25000), its projections (LINZS25002) and New Zealand Vertical Datum 2016 (LINZS25009); fact sheets on the datum, projections and transformations (LINZG25700, LINZG25702, LINZG25703); guidance on transforming between ITRF and NZGD2000; and J. Hannah's 2001 assessment of New Zealand's height systems and options for a future height datum, prepared for the Surveyor-General. |
| Intergovernmental Committee on Surveying and Mapping | Terms stated in the manual | GDA2020 Technical Manual, version 1.8 (2024). |
| New Zealand Petroleum and Minerals | Crown copyright, reproduced with permission under the publisher's copyright terms; the required acknowledgment travels with every citation | New Zealand's Petroleum Basins, Parts One and Two (2014). |

These documents let the agents answer questions about datums and coordinate transformations, airborne geophysics, gravity and New Zealand's petroleum basins, alongside the Australian basin geology.

## Map services

| Service | Terms |
|---|---|
| Azure Maps (base map) | Uses Microsoft Entra tokens and an identity that can only read map tiles. |
| Esri base maps (optional) | Through the ArcGIS Location Platform. Requires the deploying organization's own API key and acceptance of Esri's terms. |
| Microsoft Planetary Computer Pro collections (optional), such as Copernicus DEM GLO-30 and Sentinel-2 Level-2A | Carry the Copernicus program's terms and attribution, and are shown with the liability notice those terms require. |

## Add your own sources

- **A public document** joins the live library through the registry, with a pinned checksum, its publisher, license, attribution and the basis on which its license was confirmed. The live-lane README explains the catalog importer for Geoscience Australia eCat records.
- **A curated dataset** joins the knowledge model through a producer in the ingestion framework and a row in the source manifest.
- **Proprietary data** is added the same way and stays within your tenant and governance.
