#!/usr/bin/env python3
"""Draws the GeoBasin Explorer AI end-to-end technical architecture in draw.io.

    python3 docs/architecture/src/technical-architecture.py   writes technical-architecture.drawio and .html
    node docs/architecture/src/render-png.mjs                  renders technical-architecture.png from the .drawio file

Columns are service boundaries (users, edge, Azure Container Apps, Microsoft Foundry with the Azure AI and data
services, Microsoft Fabric); rows are the question path, knowledge and tools, and ingestion. Every component traces to
infra/bicep and infra/terraform. Every box is placed by hand, so the file stays editable in diagrams.net or the Draw.io
extension for Visual Studio Code.

Icons are embedded so the file opens anywhere: the Azure Architecture Icons from the orrery skill's bundled pack
(ORRERY_ICONS); the Microsoft Entra and Microsoft Fabric icons from the sets that Microsoft publishes for architecture
diagrams (downloaded once into GBX_ICON_CACHE); and neutral Tabler or Logos glyphs (ICONIFY_CACHE) where no official
icon exists, such as the ontology.
"""
import base64
import html
import json
import os
import pathlib
import urllib.request
import zipfile
from xml.sax.saxutils import escape

HERE = pathlib.Path(__file__).resolve().parent
OUT_DIR = HERE.parent
NAME = "technical-architecture"
HOME = pathlib.Path.home()
ORRERY_ICONS = pathlib.Path(os.environ.get("ORRERY_ICONS", HOME / ".copilot/installed-plugins/awesome-copilot/orrery/skills/orrery/assets/icons/azure.json"))
ICONIFY = pathlib.Path(os.environ.get("ICONIFY_CACHE", HOME / ".cache/orrery"))
CACHE = pathlib.Path(os.environ.get("GBX_ICON_CACHE", HOME / ".cache/geobasin-architecture-icons"))
ICON_SETS = {
    "entra": ("https://download.microsoft.com/download/3/1/a/31a56038-856a-4489-88e4-ee5a1c4352be/Microsoft%20Entra%20architecture%20icons%20-%20Oct%202023.zip",
              "entra-architecture-icons-oct-2023.zip"),
    "fabric": ("https://github.com/microsoft/fabric-samples/raw/main/docs-samples/Icons.zip", "fabric-icons.zip"),
}
FABRIC_SVG = "v6.1.0/package/dist/svg/"
ENTRA_SVG = "Microsoft Entra architecture icons - Oct 2023/Microsoft Entra color icons SVG/"

W, H = 2200, 1250
NAVY, GREY, MUTED, INK = "#0B2A4A", "#4A5568", "#5F6B7A", "#1F2937"
AZ, AZ_FILL, AZ_DARK = "#0078D4", "#F3F8FD", "#005A9E"
AI, AI_FILL, AI_DARK = "#7A4CC2", "#F8F5FD", "#5B2E9E"
FAB, FAB_FILL, FAB_DARK = "#117865", "#EFF8F4", "#0B4F42"
NEUTRAL, NEUTRAL_FILL = "#8A94A6", "#FFFFFF"
PLAT, PLAT_FILL = "#3F3D56", "#F6F6F9"
Q, ING, SUP = "#0078D4", "#117865", "#6B7280"
FONT = "fontFamily=Helvetica;"


def _zip(key: str) -> zipfile.ZipFile:
    url, file = ICON_SETS[key]
    path = CACHE / file
    if not path.exists():
        CACHE.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url) as response:
            path.with_suffix(".part").write_bytes(response.read())
        path.with_suffix(".part").rename(path)
    return zipfile.ZipFile(path)


_azure = json.loads(ORRERY_ICONS.read_text())["icons"]


def azure(name: str) -> str:
    icon = _azure[name]
    while "r" in icon:
        icon = _azure[icon["r"]]
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{icon["v"]}">{icon["b"]}</svg>'


def fabric(file: str) -> str:
    return _zip("fabric").read(FABRIC_SVG + file).decode()


def entra(file: str) -> str:
    return _zip("entra").read(ENTRA_SVG + file).decode()


def iconify(pack: str, name: str, color: str = GREY) -> str:
    data = json.loads(next(ICONIFY.glob(f"@iconify-json+{pack}@*/icons.json")).read_text())
    icon = data["icons"][name]
    w, h = icon.get("width", data.get("width", 24)), icon.get("height", data.get("height", 24))
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" color="{color}">{icon["body"]}</svg>'


cells: list[str] = []
geometry: dict[str, tuple[float, float, float, float]] = {}


def quote(value: str) -> str:
    return '"' + escape(value, {'"': "&quot;"}) + '"'


def _cell(cid, value, style, x, y, w, h, parent=None):
    """A vertex at absolute (x, y); inside a parent its geometry is written relative to the parent, as draw.io expects."""
    geometry[cid] = (x, y, w, h)
    px, py = (geometry[parent][0], geometry[parent][1]) if parent else (0, 0)
    cells.append(f'<mxCell id="{cid}" value={quote(value)} style="{style}" vertex="1" parent="{parent or "1"}">'
                 f'<mxGeometry x="{x - px:g}" y="{y - py:g}" width="{w:g}" height="{h:g}" as="geometry"/></mxCell>')


def box(cid, x, y, w, h, title, stroke, fill, color, dashed=False, parent=None, size=16):
    style = (f"rounded=1;arcSize=3;whiteSpace=wrap;html=1;container=1;collapsible=0;recursiveResize=0;verticalAlign=top;align=left;"
             f"spacingLeft=12;spacingTop=6;fontSize={size};fontStyle=1;fontColor={color};strokeColor={stroke};fillColor={fill};"
             f"strokeWidth=1.6;{'dashed=1;dashPattern=6 4;' if dashed else ''}{FONT}")
    _cell(cid, title, style, x, y, w, h, parent)


def text(cid, x, y, w, h, value, size=13, color=GREY, align="left", bold=False, parent=None):
    style = (f"text;html=1;whiteSpace=wrap;align={align};verticalAlign=top;spacing=0;fontSize={size};fontColor={color};"
             f"{'fontStyle=1;' if bold else ''}{FONT}")
    _cell(cid, value, style, x, y, w, h, parent)


def node(cid, cx, y, svg, name, note="", parent=None, size=56, label_w=190, label_h=50):
    """An icon centred on cx with its caption underneath, grouped so both move together. Edges attach to the icon
    (<cid>-i) when they run sideways and to the group (<cid>) when they leave or enter below the caption."""
    _cell(cid, "", "group;", cx - label_w / 2, y, label_w, size + 4 + label_h, parent)
    data = base64.b64encode(svg.encode()).decode()
    _cell(f"{cid}-i", "", f"shape=image;html=1;imageAspect=0;aspect=fixed;image=data:image/svg+xml,{data};", cx - size / 2, y, size, size, cid)
    caption = f"<b>{name}</b>" + (f'<br><font style="font-size:12px" color="{MUTED}">{note}</font>' if note else "")
    text(f"{cid}-t", cx - label_w / 2, y + size + 4, label_w, label_h, caption, size=14, color=INK, align="center", parent=cid)


edges: list[str] = []


def badge(n: int, label: str) -> str:
    return (f'<span style="display:inline-block;width:22px;height:22px;line-height:22px;border-radius:11px;background:{Q};'
            f'color:#FFFFFF;text-align:center;font-weight:bold;font-size:13px">{n}</span>&nbsp;{label}')


def edge(cid, source, target, label="", color=Q, width=2.5, dashed=False, exit=None, entry=None, points=(), offset=None):
    style = (f"edgeStyle=orthogonalEdgeStyle;rounded=1;html=1;strokeWidth={width:g};strokeColor={color};endArrow=block;endFill=1;"
             f"endSize=7;fontSize=13;fontStyle=1;fontColor={color};labelBackgroundColor=#FFFFFF;{FONT}"
             f"{'dashed=1;dashPattern=8 5;' if dashed else ''}")
    if exit:
        style += f"exitX={exit[0]:g};exitY={exit[1]:g};exitDx=0;exitDy=0;"
    if entry:
        style += f"entryX={entry[0]:g};entryY={entry[1]:g};entryDx=0;entryDy=0;"
    pts = "".join(f'<mxPoint x="{px:g}" y="{py:g}"/>' for px, py in points)
    off = f'<mxPoint x="{offset[0]:g}" y="{offset[1]:g}" as="offset"/>' if offset else ""
    arr = f'<Array as="points">{pts}</Array>' if pts else ""
    edges.append(f'<mxCell id="{cid}" value={quote(label)} style="{style}" edge="1" parent="1" source="{source}" target="{target}">'
                 f'<mxGeometry relative="1" as="geometry">{off}{arr}</mxGeometry></mxCell>')


def sample(cid, x1, y, x2, color, width, dashed=False):
    style = (f"html=1;strokeWidth={width:g};strokeColor={color};endArrow=block;endFill=1;endSize=7;"
             f"{'dashed=1;dashPattern=8 5;' if dashed else ''}")
    edges.append(f'<mxCell id="{cid}" value="" style="{style}" edge="1" parent="1"><mxGeometry relative="1" as="geometry">'
                 f'<mxPoint x="{x1:g}" y="{y:g}" as="sourcePoint"/><mxPoint x="{x2:g}" y="{y:g}" as="targetPoint"/></mxGeometry></mxCell>')


# Header and legend ------------------------------------------------------------------------------------------------------
text("title", 30, 22, 1500, 44, f'<font color="{AZ}">GeoBasin Explorer AI</font>&nbsp;&nbsp;<font color="{NAVY}">End-to-end technical architecture</font>',
     size=32, bold=True)
text("subtitle", 32, 72, 1500, 30, "Microsoft Azure and Microsoft Fabric&nbsp;&nbsp;·&nbsp;&nbsp;deploy into your own subscription with Bicep or Terraform",
     size=17, color=GREY)
box("legend", 1640, 18, 530, 108, "", "#D5DBE3", "#FFFFFF", GREY)
for i, (color, width, dashed, label) in enumerate([(Q, 3, False, "Question path (numbered steps)"),
                                                   (ING, 2.2, True, "Ingestion and knowledge build"),
                                                   (SUP, 1.6, False, "Supporting call")]):
    y = 42 + i * 30
    sample(f"legend-{i}", 1662, y, 1742, color, width, dashed)
    text(f"legend-t{i}", 1758, y - 10, 400, 22, label, size=14, color=INK)

# Boundaries ---------------------------------------------------------------------------------------------------------------
TOP, R1_BOTTOM, LOWER_TOP, BOTTOM = 150, 485, 505, 995
box("users-box", 30, TOP, 220, R1_BOTTOM - TOP, "Users", NEUTRAL, NEUTRAL_FILL, GREY, dashed=True)
box("sources-box", 30, 700, 220, BOTTOM - 700, "Sources", NEUTRAL, NEUTRAL_FILL, GREY, dashed=True)
box("edge-box", 290, TOP, 210, R1_BOTTOM - TOP, "Identity and edge", AZ, AZ_FILL, AZ_DARK)
box("aca-box", 540, TOP, 400, BOTTOM - TOP, "Azure Container Apps", AZ, AZ_FILL, AZ_DARK)
box("foundry-box", 980, TOP, 740, R1_BOTTOM - TOP, "Microsoft Foundry", AI, AI_FILL, AI_DARK)
box("nsp-box", 1450, 318, 255, 155, "Agent data", AI, "#FFFFFF", AI_DARK, dashed=True, size=14)
box("data-box", 980, LOWER_TOP, 740, BOTTOM - LOWER_TOP, "Azure AI and data services", AZ, AZ_FILL, AZ_DARK)
box("fabric-box", 1760, TOP, 410, BOTTOM - TOP, "Microsoft Fabric", FAB, FAB_FILL, FAB_DARK)
box("platform-box", 30, 1045, 2140, 185, "Platform, security and operations", PLAT, PLAT_FILL, PLAT)

# Components ---------------------------------------------------------------------------------------------------------------
R1, R1B, R2, R3 = 190, 350, 555, 760
container = azure("worker-container-app")
models = azure("foundry-models")
node("users", 140, R1, azure("users"), "Users", "Geoscientists, engineers, data teams")
node("publishers", 140, R3, iconify("tabler", "world", GREY), "Public data publishers", "Open geoscience data")
node("operator", 140, 870, iconify("tabler", "device-laptop", GREY), "Operator or CI", "Ingestion framework")
node("frontdoor", 395, R1, azure("front-door-and-cdn-profiles"), "Azure Front Door", "Web application firewall", label_w=200)
node("entra", 395, R1B, entra("Microsoft Entra ID color icon.svg"), "Microsoft Entra ID", "Sign-in and app roles", label_w=200)
node("web", 740, R1, container, "Web app and API", "UI, sign-in, prepared answers")
node("spatial", 640, R2, container, "Spatial service", "GDAL and PROJ")
node("tools", 840, R2, iconify("tabler", "tool", AZ), "MCP tool server", "Read-only tools")
node("jobs", 740, R3, container, "Ingestion jobs", "Fetch, scan, read, index")
node("agents", 1110, R1, azure("foundry-agent-service"), "Hosted agents", "Copilot and Co-Scientist")
node("router", 1110, R1B, models, "Model router", "Drafts answers")
node("validator", 1320, R1B, models, "Validator model", "Checks every statement")
node("cosmos", 1515, 355, azure("azure-cosmos-db"), "Cosmos DB", "Threads", size=48, label_w=120)
node("agentstore", 1640, 355, azure("storage-accounts"), "Storage", "Agent files", size=48, label_w=120)
node("search", 1150, R2, azure("cognitive-search"), "Azure AI Search", "Hybrid, vector and geo search")
node("embed", 1350, R2, models, "Foundry Models", "Embeddings and checks", label_w=170)
node("maps", 1550, R2, azure("azure-maps-accounts"), "Azure Maps", "Base maps and imagery")
node("docint", 1150, R3, azure("form-recognizers"), "Document Intelligence", "OCR and layout")
node("storage", 1550, R3, azure("storage-accounts"), "Azure Storage", "Document library")
node("ontology", 1860, R1, iconify("tabler", "schema", FAB), "Ontology", "Fabric IQ endpoint")
node("graph", 2070, R1, fabric("graph_model_instance_64_item.svg"), "Graph model", "Graph queries")
node("lakehouse", 1965, R2, fabric("lakehouse_64_item.svg"), "Lakehouse", "Knowledge tables")
node("pipeline", 1965, R3, fabric("pipeline_64_item.svg"), "Data pipeline", "Notebooks")

platform = [
    ("managed-identities", azure("managed-identities"), "Managed identities", "Keyless access"),
    ("key-vault", azure("key-vaults"), "Azure Key Vault", "Secrets"),
    ("registry", azure("container-registries"), "Container Registry", "App images"),
    ("monitor", azure("monitor"), "Azure Monitor", "Logs and alerts"),
    ("insights", azure("application-insights"), "Application Insights", "Telemetry"),
    ("purview", fabric("purview_48_color.svg"), "Microsoft Purview", "Catalog and lineage (optional)"),
    ("defender", azure("microsoft-defender-for-cloud"), "Defender for Storage", "Malware scanning"),
    ("budgets", azure("cost-budgets"), "Cost budgets", "Spend alerts"),
    ("logic", azure("logic-apps"), "Logic Apps", "Resumes Fabric capacity"),
    ("iac", iconify("tabler", "file-code", GREY), "Bicep or Terraform", "Infrastructure as code"),
    ("actions", iconify("logos", "github-actions"), "GitHub Actions", "Build and test"),
]
step = 2140 / len(platform)
for i, (cid, svg, name, note) in enumerate(platform):
    node(f"p-{cid}", 30 + step * (i + 0.5), 1090, svg, name, note, size=46, label_w=step - 10)

# Flows --------------------------------------------------------------------------------------------------------------------
SIDE_OUT, SIDE_IN = (1, 0.5), (0, 0.5)
edge("q1", "users-i", "frontdoor-i", badge(1, "HTTPS"), width=3, exit=SIDE_OUT, entry=SIDE_IN)
edge("q2", "frontdoor-i", "web-i", badge(2, "Private Link"), width=3, exit=SIDE_OUT, entry=SIDE_IN)
edge("q3", "web-i", "agents-i", badge(3, "On behalf of the user"), width=3, exit=SIDE_OUT, entry=SIDE_IN)
edge("q4", "agents-i", "ontology-i", badge(4, "Fabric IQ"), width=3, exit=SIDE_OUT, entry=SIDE_IN)
edge("q5", "agents", "tools-i", "MCP tools", exit=(0.12, 1), entry=(0.5, 0), points=((1038, 322), (960, 322), (960, R2 - 32), (840, R2 - 32)))
edge("q6", "tools-i", "search-i", "Passages", exit=SIDE_OUT, entry=SIDE_IN)
edge("q7", "agents", "router-i", "Draft", width=2, exit=(0.5, 1), entry=(0.5, 0))
edge("q8", "agents", "validator-i", "Validate", width=2, exit=(0.8, 1), entry=(0.5, 0), points=((1148, R1B - 24), (1320, R1B - 24)))
edge("s1", "users", "entra-i", "Sign in", color=SUP, width=1.6, exit=(0.5, 1), entry=SIDE_IN, points=((140, R1B + 28),))
edge("s2", "web", "spatial-i", "Measure", color=SUP, width=1.6, exit=(0.5, 1), entry=(0.5, 0), points=((740, 430), (640, 430)))
edge("i1", "publishers-i", "jobs-i", "Fetch", color=ING, width=2.2, dashed=True, exit=SIDE_OUT, entry=SIDE_IN)
edge("i2", "jobs-i", "docint-i", "Read", color=ING, width=2.2, dashed=True, exit=SIDE_OUT, entry=SIDE_IN)
edge("i3", "jobs-i", "search", "Index", color=ING, width=2.2, dashed=True, exit=(0.5, 0), entry=(0.5, 1), points=((740, 700), (1150, 700)))
edge("i4", "jobs", "storage", "Store", color=ING, width=2.2, dashed=True, exit=(0.5, 1), entry=(0.5, 1), points=((740, 945), (1550, 945)))
edge("i5", "operator", "pipeline", "Land files and run the pipeline", color=ING, width=2.2, dashed=True, exit=(0.5, 1), entry=(0.5, 1),
     points=((140, 1020), (1965, 1020)))
edge("i6", "pipeline-i", "lakehouse", "Load", color=ING, width=2.2, dashed=True, exit=(0.5, 0), entry=(0.5, 1))
edge("i7", "lakehouse-i", "ontology", "Bindings", color=ING, width=2.2, dashed=True, exit=(0.5, 0), entry=(0.5, 1),
     points=((1965, 345), (1860, 345)), offset=(-62, -29))
edge("i8", "lakehouse-i", "graph", "Graph", color=ING, width=2.2, dashed=True, exit=(0.5, 0), entry=(0.5, 1),
     points=((1965, 345), (2070, 345)), offset=(52, -29))

# Output -------------------------------------------------------------------------------------------------------------------
model = (f'<mxGraphModel dx="{W}" dy="{H}" grid="0" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" '
         f'pageScale="1" pageWidth="{W}" pageHeight="{H}" background="#FFFFFF" math="0" shadow="0"><root><mxCell id="0"/>'
         f'<mxCell id="1" parent="0"/>{"".join(cells)}{"".join(edges)}</root></mxGraphModel>')
xml = (f'<mxfile host="geobasin" agent="docs/architecture/src/{NAME}.py" type="device">'
       f'<diagram id="technical-architecture" name="Technical architecture">{model}</diagram></mxfile>')
(OUT_DIR / f"{NAME}.drawio").write_text(xml, encoding="utf-8")

config = {"highlight": "#0078D4", "nav": True, "resize": True, "toolbar": "zoom lightbox", "edit": "_blank", "xml": xml}
page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeoBasin Explorer AI: end-to-end technical architecture</title>
<style>
  body {{ margin: 0; font-family: "Segoe UI", Helvetica, Arial, sans-serif; color: #1F2937; background: #F7F9FB; }}
  header {{ padding: 20px 28px 8px; }}
  h1 {{ margin: 0 0 6px; font-size: 24px; color: #0B2A4A; }}
  p {{ margin: 6px 0; max-width: 1100px; line-height: 1.5; }}
  nav a {{ margin-right: 18px; color: #0078D4; }}
  .frame {{ margin: 12px 28px 28px; background: #FFFFFF; border: 1px solid #D0D7DE; border-radius: 6px; padding: 8px; overflow: auto; }}
  .fallback img {{ width: 100%; height: auto; }}
</style>
</head>
<body>
<header>
  <h1>GeoBasin Explorer AI: end-to-end technical architecture</h1>
  <p>Use the toolbar to zoom or open the diagram full screen. The pencil opens an editable copy in diagrams.net.</p>
  <nav><a href="{NAME}.drawio">Editable source (.drawio)</a><a href="{NAME}.png">Image (.png)</a><a href="../ARCHITECTURE.md">Architecture guide</a></nav>
</header>
<div class="frame">
  <div class="mxgraph" style="max-width:100%;border:0" data-mxgraph="{html.escape(json.dumps(config), quote=True)}"></div>
  <noscript><div class="fallback"><img src="{NAME}.png" alt="GeoBasin Explorer AI end-to-end technical architecture"></div></noscript>
</div>
<script>
  window.addEventListener("error", function (e) {{
    if (e.target && e.target.tagName === "SCRIPT") {{
      document.querySelector(".frame").innerHTML = '<div class="fallback"><img src="{NAME}.png" alt="GeoBasin Explorer AI end-to-end technical architecture"></div>';
    }}
  }}, true);
</script>
<script src="https://viewer.diagrams.net/js/viewer-static.min.js"></script>
</body>
</html>
"""
(OUT_DIR / f"{NAME}.html").write_text(page, encoding="utf-8")
print(f"wrote {NAME}.drawio ({len(xml) // 1024} KB) and {NAME}.html; {len(cells)} vertices, {len(edges)} edges")
