import { LivePublishedSource } from "@/components/panels/live-page";
import { EMPTY_LIVE, liveApi, liveMapMarkers, liveMapStatus, type LiveClientManifest } from "@/lib/live";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { toast } from "sonner";
import { BookOpen, ChevronDown, ClipboardCheck, Database, FilePlus2, FileSearch, FlaskConical, Gauge, Images as ImagesIcon, Info, Layers, Leaf, ListOrdered, Map as MapIcon, Minus, MoreHorizontal, Network, NotebookText, Pentagon, Play, Plus, RotateCcw, ShieldCheck, Spline, X } from "lucide-react";
import { CopilotAvatar } from "@/components/brand";
import { BRAND } from "@brand";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useConfirm } from "@/hooks/use-confirm";
import { useAppShortcut, useShortcutScope } from "@/components/shortcut-provider";
import { cn } from "@/lib/utils";
import { BasinMap, BASE_MAPS, DEFAULT_BASE_MAP, NO_FILTER, YEAR_MIN, YEAR_MAX, filterOn, passFilter, type BasinMapProps, type BhFilter, type FlyRequest, type HoverInfo, type MapControl, type BaseTiles, type MapLayers, type MapPin as Pin, type SiteMarker } from "@/components/basin-map";
import { BASINS, basinById, depthAt, depthLabel, fmt, type LonLat } from "@/lib/basins";
import { PACK, WELLS, km, wellById, whatHere, withSpatial, NEAR_KM, STATUS_CLS, type Bench, type Entity, type HereInfo, type Play5 } from "@/lib/pack";
import { answer5, sourceList, type Answer5, type AnswerLabel } from "@/lib/answer5";
import { CLOUD, GATED, cloud, failureAnswer, type AskProgress, type EsriStatus, type Me, type PlanetaryLayer, type PlanetaryStatus } from "@/lib/cloud";
import { searchStats, tokenize, type MapHit } from "@/lib/search";
import { STARTERS } from "@/lib/ask";
import { suggestedQuestions } from "@/lib/suggest";
import { autoCheck, type TestRow, type TestRun } from "@/lib/autocheck";
import { effectText, rankable, setFeedbackStore, type Feedback, type Reason, type Vote } from "@/lib/feedback";
import type { IngestResult } from "@/lib/ingest";
import type { Geotag } from "@/lib/geotag";
import type { ImageOpen } from "@/lib/images";
import { testHypothesis, type HDef, type HResult } from "@/lib/hypothesis";
import { HypothesisPanel, type HypChoice } from "@/components/panels/hypothesis-panel";
import { DEFAULT_WEIGHTS, type Ranked, type Weights } from "@/lib/analog";
import { KEYS, STORAGE_OK, usePersistent } from "@/lib/persist";
import { allQuestions, exportRows, ABOUT_TEXT, type LogEntry, type ReviewState, type ScoreEntry, type ScoreState } from "@/lib/score";
import { downloadWorkbook } from "@/lib/export-xlsx";
import { useAddNote, useNotebookRows, useNotebookTable, type NoteRow } from "@/lib/notebook";
import { EXERCISES, type Action, type KnowledgeSub, type LensId, type Tab, type View } from "@/lib/track";
import type { Site, SiteField } from "@/lib/wells";
import { getKG } from "@/lib/kg";
import { imageItems, type ImgItem } from "@/lib/imgsim";
import { computeSection, PRESETS, type Section } from "@/lib/section";
import { AREA_MAX_POINTS, areaFacts, areaProblem, openRing } from "@/lib/area";
import { docLayer, type DocLayer, type DocPoint } from "@/lib/doctags";
import { LENSES, lensById, BH_TOTAL, type Kpi } from "@/lib/lenses";
import type { CoSciRun } from "@/lib/cosci";
import { SITES, OZTEMP, OZTEMP_URL, CONTEXT, imgUrl, siteById, type Site as LcSite, type SiteField as LcField } from "@/lib/lowcarbon";
import { AskPanel, type FeedbackState } from "@/components/panels/ask-panel";
import { IngestDialog } from "@/components/panels/ingest-dialog";
import { RolePicker } from "@/components/panels/role-picker";
import { registerPassages } from "@/components/panels/common";
import { LICENCE } from "@/lib/licensed-data";
import { AnalogPanel } from "@/components/panels/analog-panel";
import { EvidencePanel, type EvItem } from "@/components/panels/evidence-panel";
import { ReviewPanel, DEFAULT_FILTER, type ReviewFilter } from "@/components/panels/review-panel";
import { ScorePanel } from "@/components/panels/score-panel";
import { NotesPanel } from "@/components/panels/notes-panel";
import { DataSheet, type SheetTab } from "@/components/panels/data-sheet";
import { HereCard } from "@/components/panels/here-card";
import { TrackCard, TRACK_INIT, type TrackState } from "@/components/panels/track-card";
import { EntityCard, type ShowPlace } from "@/components/panels/entity-card";
import { LineageSheet } from "@/components/panels/lineage-sheet";
import { KnowledgeStage } from "@/components/panels/knowledge-stage";
import { ImagesStage, type SimilarQuery } from "@/components/panels/images-stage";
import { CoSciStage, type CoSciReview } from "@/components/panels/cosci-stage";
import { LensCard, LensPicker } from "@/components/panels/lens-card";
import { SectionSheet } from "@/components/panels/section-sheet";
import { DocsHereCard } from "@/components/panels/docs-here-card";
import { AreaCard, type AreaInfo } from "@/components/panels/area-card";
import { CopilotPanel, COPILOT_TOGGLE_ID, type CopilotContext, type CopilotMode } from "@/components/panels/copilot-panel";
import { EvidencePanel as LcEvidencePanel, ScreeningPanel } from "@/components/lowcarbon-panels";
import { ResizeHandle } from "@/components/resize-handle";
import { MapWindow, asRect, clampRect, type WindowRect } from "@/components/map-window";

/* The cloud build draws the map with Azure Maps; the SDK loads as a separate file only there. The test is
   written on import.meta.env.MODE directly so the offline build drops it, and the SDK, entirely. */
const AzureBasinMap = import.meta.env.MODE === "cloud" ? lazy(() => import("@/components/azure-basin-map")) : null;
const LiveReviewPanel = import.meta.env.MODE === "cloud" ? lazy(() => import("@/components/panels/live-review-panel")) : null;

const LAYER_LABELS: [keyof MapLayers, string][] = [
  ["sites", "Legacy well reports"], ["depth", "Depth to basin floor"], ["faults", "Faults and folds"], ["boreholes", "Boreholes"],
  ["seismic", "2D seismic lines (Adavale, Galilee, N Bowen)"], ["stress", "Stress (SHmax)"], ["conf", "GA data confidence"], ["docs", "Tagged documents"],
];
const OLD_TABS: Tab[] = ["ask", "analogs", "evidence", "review", "score", "notes"];
/* Workspaces carry the capability names: map, knowledge, images, Co-Scientist, data,
   evaluate (the founding benchmark) and review (expert review). The Copilot sits beside every one of them. */
type Workspace = View | "data" | "evaluate" | "review";
type Panel = "answers" | "analogs" | "evidence" | "notes" | "lowc";
const WORKSPACES: [Workspace, string, typeof MapIcon][] = [
  ["map", "Map", MapIcon], ["knowledge", "Knowledge", Network], ["images", "Images", ImagesIcon], ["cosci", "Co-Scientist", FlaskConical],
  ["data", "Data", Database], ["evaluate", "Evaluate", Gauge], ["review", "Review", ClipboardCheck],
];
const STAGE_VIEWS: Workspace[] = ["map", "knowledge", "images", "cosci"];
const PANEL_TITLE: Record<Panel, string> = { answers: "Answers", analogs: "Analogs and hypothesis checks", evidence: "Evidence", notes: "Notes", lowc: "Low-carbon screening" };
const useMedia = (q: string) => {
  const [m, setM] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(q).matches);
  useEffect(() => { const mq = window.matchMedia?.(q); if (!mq) return; const on = () => setM(mq.matches); on(); mq.addEventListener("change", on); return () => mq.removeEventListener("change", on); }, [q]);
  return m;
};
/* The side panel and the copilot are resized by dragging their inner edge, and the browser remembers the width (null
   means the default). The workspace between them keeps at least STAGE_MIN; the copilot overlay, which covers the
   workspace instead of taking room from it, leaves OVERLAY_PEEK of the workspace in view. */
const PANEL_MIN = 320, STAGE_MIN = 440, OVERLAY_PEEK = 200;
const SIDE_W = 400, DOCK_W = 380, OVERLAY_W = 400;
const fit = (pref: number | null, fallback: number, max: number) =>
  Math.round(Math.min(Math.max(typeof pref === "number" && Number.isFinite(pref) ? pref : fallback, PANEL_MIN), Math.max(PANEL_MIN, max)));
/* Docked, the copilot keeps its width and the side panel takes what is left; as an overlay, the copilot takes no room. */
function panelWidths(o: { row: number; side: number | null; copilot: number | null; sideOpen: boolean; copilotOpen: boolean; docked: boolean }) {
  if (o.docked) {
    const copilot = fit(o.copilot, DOCK_W, o.row - STAGE_MIN - (o.sideOpen ? PANEL_MIN : 0));
    const sideMax = o.row - STAGE_MIN - (o.copilotOpen ? copilot : 0), side = fit(o.side, SIDE_W, sideMax);
    return { side, sideMax, copilot, copilotMax: o.row - STAGE_MIN - (o.sideOpen ? side : 0) };
  }
  const sideMax = o.row - STAGE_MIN, side = fit(o.side, SIDE_W, sideMax);
  const copilotMax = o.row - (o.sideOpen ? side : 0) - OVERLAY_PEEK;
  return { side, sideMax, copilot: fit(o.copilot, OVERLAY_W, copilotMax), copilotMax };
}
const SEISMIC: LonLat[][] = Object.values(PACK.seismic2d).flat();
const MARKERS: SiteMarker[] = WELLS.map((w) => ({ id: w.siteId, lon: w.lon, lat: w.lat, label: w.name, tag: `${w.spudYear ?? ""} report`, kind: "legacy" }));
const LC_MARKERS: SiteMarker[] = [
  ...SITES.filter((s) => !WELLS.some((w) => w.siteId === s.siteId)).map((s) => ({ id: s.siteId, lon: s.lon, lat: s.lat, label: s.name, tag: s.tag, kind: (s.kind === "geo" ? "geo" : "co2") as SiteMarker["kind"] })),
  ...CONTEXT.map((c) => ({ id: c.id, lon: c.lon, lat: c.lat, label: c.name, tag: c.tag, kind: "context" as const })),
];
const TEMP = OZTEMP_URL ? { src: OZTEMP_URL, bounds: OZTEMP.bounds } : null;
const ILLUSTRATIVE = PACK.realness.filter((r) => r.status === "Illustrative").length;
const now16 = () => new Date().toISOString().slice(0, 16).replace("T", " ");
const safeCloudReply = (a: Answer5): Answer5 => LICENCE.gateAnswer(a) ?? failureAnswer(a.question, new Error("The requested evidence is withheld until its reuse terms are confirmed."));
const T0 = typeof performance !== "undefined" ? performance.now() : 0;
const INN = WELLS.find((w) => w.siteId === "innamincka-1");
const FLAGGED = WELLS.reduce((s, w) => s + w.stats.fieldsNeedReview, 0);
/* core photos found in the well reports, added to image search */
const REPORT_CORE = (lowc: boolean): ImgItem[] => {
  const out: ImgItem[] = [];
  for (const s of SITES) for (const pg of s.pages) {
    if (!/core/i.test(pg.file) || /analysis/i.test(pg.file) || !(lowc || s.siteId === "marabooka-1")) continue;
    const src = imgUrl(s.siteId, pg.file); if (!src) continue;
    out.push({ id: `lowc:${s.siteId}:${pg.pageId}`, nodeId: null, src, title: `${s.name}: ${pg.caption}`, sub: s.siteId === "marabooka-1" ? "Marabooka 1 report" : `${s.name} report (Low-carbon lens)`, kind: "Report photo",
      basin: s.siteId === "zerogen-2" ? "northbowen" : "cooper", unit: s.siteId === "marabooka-1" ? "Toolachee Formation" : null, play: null, wells: [s.name], top: null, base: null, source: s.source.report });
  }
  return out;
};

export function HomePage() {
  const confirm = useConfirm();
  const [panel, setPanel] = useState<Panel | null>(null);
  const [view, setView] = useState<Workspace>("map");
  const [ksub, setKsub] = useState<KnowledgeSub>("framework");
  const [entityId, setEntityId] = useState<string | null>(null);
  const [lineageId, setLineageId] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answer5[]>([]);
  const [fromQ, setFromQ] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fly, setFly] = useState<FlyRequest | null>(null);
  const seq = useRef(0);
  const [highlight, setHighlight] = useState<Set<string>>(new Set());
  const [layers, setLayers] = useState<MapLayers>({ depth: true, faults: true, boreholes: true, stress: false, conf: false, seismic: false, sites: true, docs: false, temp: false });
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [here, setHere] = useState<HereInfo | null>(null);
  const [evItem, setEvItem] = useState<EvItem | null>(null);
  const [focusField, setFocusField] = useState<string | null>(null);
  const [refId, setRefId] = useState<string>(PACK.defaultRef);
  const [weights, setWeights] = useState<Weights>(DEFAULT_WEIGHTS);
  const [filter, setFilter] = useState<ReviewFilter>(DEFAULT_FILTER);
  const [showBuild, setShowBuild] = useState(false);
  const [sheetTab, setSheetTab] = useState<SheetTab>("real");
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set());
  const [savedKeys, setSavedKeys] = useState<Set<string>>(new Set());
  const [appMs, setAppMs] = useState<number | null>(null);
  const [answerMs, setAnswerMs] = useState<number[]>([]);
  const [analogMode, setAnalogMode] = useState<"rank" | "test">("rank");
  const [hypChoice, setHypChoice] = useState<HypChoice>("analog");
  const [hypResult, setHypResult] = useState<HResult | null>(null);
  const [savedHyp, setSavedHyp] = useState<Set<string>>(new Set());
  const [bhFilter, setBhFilter] = useState<BhFilter>(NO_FILTER);
  const [depthLens, setDepthLens] = useState<[number, number] | null>(null);
  const [docs, setDocs] = useState<DocLayer | null>(null);
  const [activeDoc, setActiveDoc] = useState<string | null>(null);
  const [secA, setSecA] = useState<LonLat | null>(null);
  const [secPick, setSecPick] = useState(false);
  const [section, setSection] = useState<Section | null>(null);
  // A drawn area ("What we know in this area"): the corners placed while drawing, then the closed outline with what lies
  // inside it. One place is open at a time, so an area and "What we know here" close each other.
  const [areaPick, setAreaPick] = useState(false);
  const [areaPts, setAreaPts] = useState<LonLat[]>([]);
  const [area, setArea] = useState<AreaInfo | null>(null);
  const areaSeq = useRef(0);
  const areaHl = useRef<Set<string> | null>(null);
  const [mapEngine, setMapEngine] = useState<"azure" | "canvas">(AzureBasinMap ? "azure" : "canvas");
  const [baseMap, setBaseMap] = useState<string>(DEFAULT_BASE_MAP);
  // Esri base maps, offered beside the Azure ones when this deployment has an Esri key and Esri's credits are known.
  const [esri, setEsri] = useState<EsriStatus | null>(null);
  const esriStyle = esri?.styles.find((s) => s.id === baseMap) ?? null;
  // Planetary Computer overlays, offered only while an Esri base map is chosen: one at a time, with its opacity.
  const [planetary, setPlanetary] = useState<PlanetaryStatus | null>(null);
  const [pcId, setPcId] = useState("");
  const [pcOpacity, setPcOpacity] = useState(80);
  const hereSeq = useRef(0);
  const secSeq = useRef(0);
  const [imgQuery, setImgQuery] = useState<SimilarQuery | null>(null);
  const [imgSel, setImgSel] = useState<string | null>(null);
  const [cosciHyp, setCosciHyp] = useState<HDef["id"] | null>(null);
  const [tagAt, setTagAt] = useState<LonLat | null>(null);
  const [tagTitle, setTagTitle] = useState(""); const [tagNote, setTagNote] = useState("");
  const [lcSite, setLcSite] = useState<string | null>(null);
  const [lcMode, setLcMode] = useState<"screen" | "evidence">("screen");
  const [lcLens, setLcLens] = useState<"co2" | "geo">("co2");
  const [lensOpen, setLensOpen] = useState(false);
  /* The Copilot docks beside the workspace from 1280 px; below that it opens as an overlay and starts closed. */
  const wide = useMedia("(min-width: 1280px)");
  const lgUp = useMedia("(min-width: 1024px)");
  const [dockPref, setDockPref] = usePersistent<boolean>(KEYS.copilotDock, true);
  const [copilotWPref, setCopilotWPref] = usePersistent<number | null>(KEYS.copilotWidth, null);
  const [sideWPref, setSideWPref] = usePersistent<number | null>(KEYS.sideWidth, null);
  const [winPref, setWinPref] = usePersistent<WindowRect | null>(KEYS.mapWindow, null);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const dockOpen = wide ? dockPref : overlayOpen;
  const setDockOpen = useCallback((o: boolean) => { if (wide) setDockPref(o); else setOverlayOpen(o); }, [wide, setDockPref]);
  const copilotMode: CopilotMode = wide ? "docked" : lgUp ? "overlay" : "sheet";
  /* On tablets and phones the copilot is a modal sheet, so the page behind it is inert while it is open. */
  const behindSheet = dockOpen && copilotMode === "sheet";
  const [lens, setLensRaw] = usePersistent<LensId>("gbx-lens", "geo");
  const [findings, setFindings] = usePersistent<Record<string, string>>("gbx-findings", {});
  const [reviewer, setReviewer] = usePersistent<string>(KEYS.reviewer, "");
  const [service, setService] = useState<Me | null>(null);
  const [publication, setPublication] = useState<LiveClientManifest>(EMPTY_LIVE);
  const [liveSourceOpen, setLiveSourceOpen] = useState(false);
  const publicationView = { ...publication, requiredSourceIds: publication.requiredSourceIds ?? service?.liveSources ?? [] };
  const publicationLabel = liveMapStatus(publicationView);
  const publicationRequest = useRef(0);
  const refreshPublication = useCallback(() => {
    if (!CLOUD) return;
    const request = ++publicationRequest.current;
    void liveApi.manifest().then((manifest) => { if (request === publicationRequest.current) setPublication(manifest); })
      .catch(() => { if (request === publicationRequest.current) setPublication((current) => ({ ...EMPTY_LIVE, requiredSourceIds: current.requiredSourceIds })); });
  }, []);
  useEffect(() => {
    if (!CLOUD) return;
    refreshPublication();
    const timer = window.setInterval(refreshPublication, 10_000);
    return () => { publicationRequest.current++; window.clearInterval(timer); };
  }, [refreshPublication]);
  /* Cloud: the copilot can be asked about the point open in "What we know here": it answers from that point's figures and
     the sources geotagged near it, and from the rest of the library when a question needs it, saying which each time
     (services/api/src/answer.ts). It stops when that card closes or the map is left, so it never shapes answers out of sight. */
  const [nearScope, setNearScope] = useState(false);
  // What the Foundry scientists have read so far, while an answer from them is on its way (lib/cloud.ts ask).
  const [askProgress, setAskProgress] = useState<AskProgress | null>(null);
  const [copilotFocus, setCopilotFocus] = useState(0);
  useEffect(() => { if (!here || view !== "map") setNearScope(false); }, [here, view]);
  const [review, setReview] = usePersistent<ReviewState>(KEYS.review, {});
  const [log, setLog] = usePersistent<LogEntry[]>(KEYS.log, []);
  /* Cloud mode: expert reviews are shared and versioned on the service; the reviewer name comes from sign-in. */
  const refreshReviews = useCallback(async () => {
    if (!CLOUD) return;
    try {
      const r = await cloud.reviews();
      // The service owns entity, well-value and low-carbon decisions; anything else in the log stays as it is.
      const entityIds = new Set(PACK.entities.map((e) => e.id));
      const serverOwned = (k: string) => entityIds.has(k) || k.startsWith("field:") || k.startsWith("lowc:");
      setReview((cur) => ({ ...Object.fromEntries(Object.entries(cur).filter(([k]) => !serverOwned(k))), ...Object.fromEntries(Object.entries(r.review).filter(([id, v]) => !LICENCE.isWithheldId(id) && !LICENCE.referencesWithheld(v))) }));
      setLog((l) => [...r.log.filter((x) => !LICENCE.referencesWithheld(x)), ...l.filter((x) => !serverOwned(x.entity) && !LICENCE.referencesWithheld(x))].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 300));
    } catch { /* keep what is shown; the next refresh retries */ }
  }, [setReview, setLog]);
  useEffect(() => {
    if (!CLOUD) return;
    void cloud.me().then((m) => { setReviewer(m.name); setService(m); }).catch(() => {});
    void cloud.esri().then(setEsri).catch(() => setEsri(null));
    void cloud.planetary().then(setPlanetary).catch(() => setPlanetary(null));
    void refreshReviews();
    const t = window.setInterval(() => void refreshReviews(), 30_000);
    return () => window.clearInterval(t);
  }, [refreshReviews, setReviewer]);
  const [score, setScore] = usePersistent<ScoreState>(KEYS.score, {});
  const [custom, setCustom] = usePersistent<Bench[]>(KEYS.custom, []);
  const [track, setTrack] = usePersistent<TrackState>(KEYS.track, TRACK_INIT);
  const [rolePicked, setRolePicked] = usePersistent<boolean>("gbx-role-picked", false);
  const [roleOpen, setRoleOpen] = useState(false);
  const [feedback, setFeedback] = usePersistent<Feedback[]>("gbx-feedback", []);
  useEffect(() => { setFeedbackStore(feedback); }, [feedback]);
  const [fbByAnswer, setFbByAnswer] = useState<Record<string, FeedbackState>>({});
  const [ingestOpen, setIngestOpen] = useState(false);
  /* A brand pack can explain paused uploads in its own words; then nothing offers an upload the service would refuse. */
  const uploadsPaused = CLOUD && service?.uploads === false && !!BRAND.uploadsPaused;
  const openIngest = () => { if (uploadsPaused) toast.info(BRAND.uploadsPaused); else setIngestOpen(true); };
  const [added, setAdded] = useState<IngestResult[]>([]);
  const [userDocPts, setUserDocPts] = useState<DocPoint[]>([]);
  const [kgVer, setKgVer] = useState(0);
  const [testRun, setTestRun] = usePersistent<TestRun | null>("gbx-testrun", null);
  const [running, setRunning] = useState<{ n: number; of: number } | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const sideOpener = useRef<HTMLElement | null>(null);
  const sidePrev = useRef(false);
  const lastEx = useRef(track.n);
  useEffect(() => { if (lastEx.current !== track.n) { lastEx.current = track.n; setHere(null); setActiveDoc(null); areaSeq.current++; setArea(null); setAreaPts([]); setAreaPick(false); } }, [track.n]);
  const control = useRef<MapControl | null>(null);
  /* The base map comes from Azure Maps or, once Esri is connected, from Esri ArcGIS. The map-provider switch returns to
     the style last used with each provider, and the base-map menu picks any style; both go through pickBaseMap. */
  const lastStyle = useRef<{ azure: string; esri: string | null }>({ azure: DEFAULT_BASE_MAP, esri: null });
  const pickBaseMap = (id: string, tiles?: BaseTiles[]) => {
    if (tiles?.length) lastStyle.current.esri = id; else lastStyle.current.azure = id;
    setBaseMap(id); control.current?.setBaseMap?.(id, tiles);
  };
  const provider: "azure" | "esri" = esriStyle ? "esri" : "azure";
  const chooseProvider = (k: "azure" | "esri") => {
    if (k === provider) return;
    if (k === "azure") { pickBaseMap(lastStyle.current.azure); return; }
    const s = esri?.styles.find((x) => x.id === lastStyle.current.esri) ?? esri?.styles[0];
    if (s) pickBaseMap(s.id, s.tiles);
  };
  /* The overlay chosen in the layer panel shows only with an Esri base map; the map takes it away with Esri, and it comes
     back when Esri does. */
  const pcLayer: PlanetaryLayer | null = provider === "esri" && planetary?.enabled ? planetary.layers.find((l) => l.id === pcId) ?? null : null;
  useEffect(() => { control.current?.setOverlay?.(pcLayer, pcOpacity / 100); }, [pcLayer?.id, pcOpacity, mapEngine]); // eslint-disable-line react-hooks/exhaustive-deps
  const barRef = useRef<HTMLDivElement>(null); const mapRef = useRef<HTMLElement>(null); const rowRef = useRef<HTMLDivElement>(null);
  const [barH, setBarH] = useState(44); const [mapW, setMapW] = useState(1000); const [mapH, setMapH] = useState(800);
  const [rowW, setRowW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1440));
  useEffect(() => {
    const bar = barRef.current, map = mapRef.current, row = rowRef.current; if (!bar || !map || !row) return;
    const ro = new ResizeObserver(() => { setBarH(bar.offsetHeight); setMapW(map.offsetWidth); setMapH(map.offsetHeight); setRowW(row.offsetWidth); });
    ro.observe(bar); ro.observe(map); ro.observe(row); return () => ro.disconnect();
  }, []);
  /* The height of what is open at the top left of the map, under which the map window docks there. */
  const [leftColH, setLeftColH] = useState(0);
  const leftColObs = useRef<ResizeObserver | null>(null);
  const leftColRef = useCallback((el: HTMLDivElement | null) => {
    leftColObs.current?.disconnect(); leftColObs.current = null;
    if (!el) return;
    const ro = new ResizeObserver(() => setLeftColH(el.offsetHeight)); ro.observe(el); leftColObs.current = ro;
  }, []);
  setFeedbackStore(feedback);
  const lowc = lens === "lowc";
  const g = useMemo(() => getKG({ ccs: lowc, lowc }), [lowc]);
  const items = useMemo(() => imageItems(g, REPORT_CORE(lowc)), [g, lowc]);
  const table = useNotebookTable();
  const addNote = useAddNote(table.data);
  const noteRows = useNotebookRows(table.data, 0);
  const questions = useMemo(() => allQuestions(custom), [custom]);
  useEffect(() => { setAppMs(performance.now() - T0); const t = window.setTimeout(() => searchStats(), 400); return () => window.clearTimeout(t); }, []);
  useEffect(() => { if (!layers.docs || docs) return; let live = true; void docLayer().then((d) => { if (live) setDocs(d); }); return () => { live = false; }; }, [layers.docs, docs]);
  const bhCount = useMemo(() => { let n = 0, all = 0; for (const b of BASINS) for (const w of b.boreholes) { all++; if (passFilter(w, bhFilter)) n++; } return { n, all }; }, [bhFilter]);

  const flyTo = useCallback((lon: number, lat: number, zoom: number, label?: string, ringKm?: number) => { seq.current += 1; setFly({ seq: seq.current, lon, lat, zoom, label, ringKm }); }, []);
  const openHere = useCallback((lon: number, lat: number) => {
    setActiveDoc(null);
    areaSeq.current++; setArea(null); setAreaPts([]); setAreaPick(false);
    const local = whatHere(lon, lat, (bid, x, y) => { const b = basinById(bid); return b ? depthAt(b, x, y) : null; });
    if (!CLOUD) { setHere(local); return; }
    // Cloud: the browser's figures show at once, then the GDAL/PROJ spatial service confirms them (geodesic distances,
    // GDA2020 and MGA) and Azure AI Search lists the library's sources geotagged nearby. Each reply merges into what is
    // shown, whichever comes first. A later click, or closing the card, wins over a slow reply.
    const n = ++hereSeq.current;
    setHere({ ...local, checking: true, sourcesChecking: true });
    const same = (cur: HereInfo | null): cur is HereInfo => hereSeq.current === n && !!cur && cur.lon === lon && cur.lat === lat;
    const why = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
    cloud.here(lon, lat).then(
      (s) => setHere((cur) => (same(cur) ? withSpatial(cur, s) : cur)),
      (e: unknown) => setHere((cur) => (same(cur) ? { ...cur, checking: false, geoError: why(e, "The spatial service could not be reached.") } : cur)));
    cloud.near(lon, lat, NEAR_KM).then(
      (r) => setHere((cur) => (same(cur) ? { ...cur, sources: r, sourcesChecking: false } : cur)),
      (e: unknown) => setHere((cur) => (same(cur) ? { ...cur, sourcesChecking: false, sourcesError: why(e, "The library search could not be reached.") } : cur)));
  }, []);
  /* keepPanel: the copilot asks without switching the side panel away from what the user is doing. */
  const doAsk = useCallback(async (q: string, qid?: string, opts?: { keepPanel?: boolean }): Promise<Answer5> => {
    // Cloud mode asks the GeoBasin service (retrieval, writing and independent validation); offline answers locally.
    // The basin selected on the map is not sent: every question is answered from all four basins, so the same question
    // gets the same answer wherever the map is. Only a place the copilot is limited to narrows the search.
    const near = CLOUD && nearScope && here ? { lon: here.lon, lat: here.lat, km: NEAR_KM } : undefined;
    const a = CLOUD ? await cloud.ask(q, null, near, setAskProgress).then(safeCloudReply).catch((e: unknown) => failureAnswer(q, e)).finally(() => setAskProgress(null)) : answer5(q, { basin: null });
    setAnswers((prev) => [a, ...prev].slice(0, 30));
    if (a.ms != null) setAnswerMs((m) => [...m, a.ms!]);
    setFromQ(qid ?? null);
    if (!opts?.keepPanel) { setPanel("answers"); setEntityId(null); window.setTimeout(() => document.getElementById(`answer-${a.id}`)?.scrollIntoView({ block: "start" }), 80); }
    if (a.focus) flyTo(a.focus.lon, a.focus.lat, a.focus.zoom, a.focus.label, a.focus.ringKm);
    else if (a.focusBasin) { const b = basinById(a.focusBasin); if (b) flyTo(b.labelAt[0], b.labelAt[1], 6.2); }
    setHighlight(new Set(a.highlight));
    if (a.focusBasin) setSelected(a.focusBasin);
    if (qid) setScore((s) => ({ ...s, [qid]: { ...(s[qid] ?? {}), label: a.label } }));
    if (a.layers) setLayers((l) => ({ ...l, ...a.layers }));
    return a;
  }, [flyTo, setScore, nearScope, here]);
  const showAnswer = useCallback((a: Answer5) => {
    setView("map");
    if (a.focus) flyTo(a.focus.lon, a.focus.lat, a.focus.zoom, a.focus.label, a.focus.ringKm);
    else if (a.focusBasin) { const b = basinById(a.focusBasin); if (b) flyTo(b.labelAt[0], b.labelAt[1], 6.2); }
  }, [flyTo]);
  const openFullAnswer = useCallback((a?: Answer5) => {
    setPanel("answers"); setEntityId(null);
    if (!a) return;
    const smooth = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => document.getElementById(`answer-${a.id}`)?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "auto" }), 80);
  }, []);
  const openWell = useCallback((id: string, field?: string) => {
    if (GATED && LICENCE.isWithheldWell(id)) { setPanel("evidence"); setEntityId(null); setEvItem(id as EvItem); setFocusField(null); return; }
    const w = wellById(id); if (!w) return;
    setView("map"); setEntityId(null);
    setPanel("evidence"); setEvItem(id as EvItem); setFocusField(field ?? null); flyTo(w.lon, w.lat, 8.2, w.name);
  }, [flyTo]);
  const showHit = (h: MapHit) => { setView("map"); flyTo(h.lon, h.lat, h.kind === "basin" ? 6 : 7.6, h.label); };
  const showGeo = (gt: Geotag) => { setView("map"); if (gt.kind === "polygon" && gt.basin) { setSelected(gt.basin); flyTo(gt.lon, gt.lat, 6.1); } else flyTo(gt.lon, gt.lat, 8, gt.label); };
  const showPlace = (s: ShowPlace) => { setView("map"); if (s.kind === "polygon" && s.basin) { setSelected(s.basin); flyTo(s.lon, s.lat, 6.1); } else { flyTo(s.lon, s.lat, 8.4, s.label, 4); } };
  const openImage = (o: ImageOpen) => { if (o.type === "well") openWell(o.id, o.field); else { setPanel("evidence"); setEvItem(o.item); setEntityId(null); } };
  const openHypothesis = (id: HDef["id"]) => { setView("cosci"); setPanel("analogs"); setEntityId(null); setAnalogMode("test"); setHypChoice(id); setHypResult(testHypothesis(id, { refId, weights })); };
  const openCosci = (id?: HDef["id"]) => { setView("cosci"); setCosciHyp(id ?? null); };
  const showPlay = (p: Play5) => { const b = BASINS.find((x) => p.basins.includes(x.id)) ?? BASINS.find((x) => p.province.toLowerCase().includes(x.short.toLowerCase())); if (b) { setView("map"); setSelected(b.id); flyTo(b.labelAt[0], b.labelAt[1], 6.2, p.play); } else toast("This play's province is outside the four mapped basins."); };
  const selectEntity = (id: string) => { setEntityId(id); if (view === "map") { const n = g.nodes.get(id); if (n?.lonlat && n.type !== "basin") flyTo(n.lonlat[0], n.lonlat[1], 8, n.label); } };
  const similarTo = (id: string) => {
    const it = items.find((x) => x.id === id || x.nodeId === id); if (!it) return;
    setView("images"); setImgQuery({ id: it.id, title: it.title, src: it.src }); setImgSel(it.id);
  };
  /* Offline: measured in the browser. Cloud: measured by the GDAL/PROJ spatial service, falling back to the browser
     method, labelled as such, if the service can't answer. */
  const measureSection = async (a: LonLat, b: LonLat): Promise<Section> => {
    if (!CLOUD) return computeSection(a, b);
    const id = toast.loading("Measuring the section with the GDAL/PROJ spatial service…");
    try { return { ...(await cloud.section(a, b)), engine: "gdal" }; }
    catch (e) { return { ...computeSection(a, b), engine: "browser", fallback: e instanceof Error ? e.message : "The spatial service could not be reached." }; }
    finally { toast.dismiss(id); }
  };
  const showSection = (a: LonLat, b: LonLat) => { const n = ++secSeq.current; void measureSection(a, b).then((s) => { if (secSeq.current === n) setSection(s); }); };
  const closeSection = () => { secSeq.current++; setSection(null); setSecA(null); };
  const startSection = (a?: LonLat) => { secSeq.current++; clearArea(); setView("map"); setSection(null); setHere(null); if (a) { setSecA(a); setSecPick(true); toast("Now click the end point (B)"); } else { setSecA(null); setSecPick(true); toast("Click the start point (A), then the end point (B)"); } };
  const pickSection = (lon: number, lat: number) => {
    if (!secA) { setSecA([lon, lat]); return; }
    setSecPick(false); showSection(secA, [lon, lat]);
  };
  /* Drawing an area: each click places a corner, and a double-click, a click on the first corner, Enter or Finish closes
     it. The browser's counts show at once; in the cloud build the library search and Planetary Computer Pro follow, and
     a later area, or closing this one, wins over a slow reply. */
  const clearArea = () => { areaSeq.current++; setAreaPick(false); setAreaPts([]); setArea(null); };
  const startArea = () => { clearArea(); secSeq.current++; setSecPick(false); setView("map"); setHere(null); setActiveDoc(null); setAreaPick(true); };
  const openArea = (ring: LonLat[]) => {
    const n = ++areaSeq.current;
    const facts = areaFacts(ring, filterOn(bhFilter) ? (w) => passFilter(w, bhFilter) : null);
    const pcOn = CLOUD && !!planetary?.enabled;
    setHere(null); setActiveDoc(null); setAreaPts(ring);
    setArea({ ...facts, sourcesChecking: CLOUD, pcChecking: pcOn });
    if (!CLOUD) return;
    const why = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
    const merge = (part: Partial<AreaInfo>) => { if (areaSeq.current === n) setArea((cur) => (cur ? { ...cur, ...part } : cur)); };
    cloud.areaSources(ring).then((r) => merge({ sources: r, sourcesChecking: false }), (e: unknown) => merge({ sourcesChecking: false, sourcesError: why(e, "The library search could not be reached.") }));
    if (pcOn) cloud.planetaryArea(ring).then((r) => merge({ pc: r, pcChecking: false }), (e: unknown) => merge({ pcChecking: false, pcError: why(e, "Planetary Computer could not be reached.") }));
  };
  const finishArea = () => {
    const ring = openRing(areaPts);
    const problem = areaProblem(ring);
    if (problem) { toast.error(problem); return; }
    setAreaPick(false); openArea(ring);
  };
  const pickArea = (lon: number, lat: number, at: "first" | "last" | null) => {
    if (at === "last") return;
    if (at === "first") { finishArea(); return; }
    if (areaPts.length >= AREA_MAX_POINTS) { toast.info(`An area can have at most ${AREA_MAX_POINTS} corners. Finish it, or undo a corner.`); return; }
    setAreaPts([...areaPts, [Number(lon.toFixed(6)), Number(lat.toFixed(6))]]);
  };
  const areaKeys = useRef({ clear: clearArea, finish: finishArea });
  areaKeys.current = { clear: clearArea, finish: finishArea };
  useEffect(() => {
    if (!areaPick) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [contenteditable], [role='dialog']")) return;
      if (e.key === "Escape") { e.preventDefault(); areaKeys.current.clear(); }
      // A focused button or link keeps Enter and Backspace for itself.
      else if (t?.closest("button, a")) return;
      else if (e.key === "Enter") { e.preventDefault(); areaKeys.current.finish(); }
      else if (e.key === "Backspace") { e.preventDefault(); setAreaPts((p) => p.slice(0, -1)); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [areaPick]);
  // The card says how many of the boreholes inside the map's borehole filter shows, so it follows the filter.
  useEffect(() => {
    setArea((cur) => {
      if (!cur) return cur;
      const filtered = filterOn(bhFilter) ? cur.boreholes.keys.reduce((n, k) => { const [bid, i] = k.split(":"); const w = basinById(bid)?.boreholes[Number(i)]; return n + (w && passFilter(w, bhFilter) ? 1 : 0); }, 0) : null;
      return filtered === cur.boreholes.filtered ? cur : { ...cur, boreholes: { ...cur.boreholes, filtered } };
    });
  }, [bhFilter]);
  const zoomToArea = () => {
    if (!area) return;
    const [w, s, e, n] = area.bbox;
    const X = (lon: number) => (lon + 180) / 360, Y = (lat: number) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;
    const z = Math.log2(Math.min((mapW * 0.6) / (256 * Math.max(1e-9, X(e) - X(w))), (mapH * 0.6) / (256 * Math.max(1e-9, Y(s) - Y(n)))));
    flyTo((w + e) / 2, (s + n) / 2, Math.max(4, Math.min(11, z)));
  };
  const highlightArea = () => {
    if (!area) return;
    if (areaHl.current && highlight === areaHl.current) { setHighlight(new Set()); return; }
    const s = new Set(area.boreholes.keys); areaHl.current = s; setHighlight(s);
  };
  const saveArea = () => {
    if (!area) return;
    const wells = area.wells.filter((w) => !GATED || !LICENCE.isWithheldWell(w.id));
    const dem = area.pc?.elevation;
    addNote.mutate({ kind: "Area", title: `Area of ${fmt(area.areaKm2)} km²: ${area.basins.map((b) => b.name).join(", ") || "outside the four basins"}`,
      note: `${area.ring.length} corners around ${Math.abs(area.centre[1]).toFixed(3)}°S ${area.centre[0].toFixed(3)}°E. ${area.boreholes.n} boreholes inside${area.depth ? `; depth to basin floor ${fmt(Math.round(area.depth.min / 10) * 10)} to ${fmt(Math.round(area.depth.max / 10) * 10)} m` : ""}; ${area.faults.n} fault traces; ${wells.length ? `well reports: ${wells.map((w) => w.name).join(", ")}` : "no well report"}${dem ? `; ground height ${fmt(dem.min)} to ${fmt(dem.max)} m (Copernicus DEM)` : ""}. Corners: ${area.ring.map(([x, y]) => `${y.toFixed(4)} ${x.toFixed(4)}`).join("; ")}.`,
      basin: area.basins[0]?.name ?? "", lon: area.centre[0], lat: area.centre[1],
      sources: `GA basin packages (CC BY 4.0), World Stress Map 2025${dem ? `; ${area.pc!.credits.elevation}` : ""}` }, { onSuccess: () => toast.success("Area saved to notes") });
  };
  const runPreset = (id: string) => { const pr = PRESETS.find((x) => x.id === id); if (!pr) return; setView("map"); setSecPick(false); setSecA(pr.a); setHere(null); showSection(pr.a, pr.b);
    flyTo((pr.a[0] + pr.b[0]) / 2, (pr.a[1] + pr.b[1]) / 2, km(pr.a[0], pr.a[1], pr.b[0], pr.b[1]) > 350 ? 5.7 : 6.6); };
  const setLens = useCallback((id: LensId) => {
    const l = lensById(id); setLensRaw(id); setLensOpen(true);
    setLayers((cur) => ({ ...cur, ...(l.layers as Partial<MapLayers>) }));
    if (id !== "lowc") setPanel((cur) => (cur === "lowc" ? null : cur));
    if (id === "lowc") { setPanel("lowc"); setEntityId(null); }
    setView(l.view);
  }, [setLensRaw]);

  /* Older links and tour steps name the tabs of the previous layout; send each to where it lives now. */
  const goTab = (t: Tab) => {
    setEntityId(null);
    if (t === "ask") { setDockOpen(true); window.setTimeout(() => document.querySelector<HTMLTextAreaElement>("#gbx-copilot textarea")?.focus(), 60); }
    else if (t === "analogs") { setView("cosci"); setPanel("analogs"); }
    else if (t === "evidence" || t === "notes") setPanel(t);
    else if (t === "review") setView("review");
    else if (t === "score") setView("evaluate");
  };

  const run = useCallback((acts: Action[]) => {
    for (const a of acts) {
      if (GATED && (LICENCE.referencesWithheld(a) || (a.type === "ingest" && a.sample))) { toast.info("This evidence is withheld until its reuse terms are confirmed."); continue; }
      if (a.type === "ask") doAsk(a.q);
      else if (a.type === "tab") goTab(a.tab);
      else if (a.type === "well") openWell(a.id, a.field);
      else if (a.type === "evidence") { setPanel("evidence"); setEntityId(null); setEvItem(a.item === "velocity" ? "velocity" : a.item === "figure" ? "figure" : a.item === "las" ? "las" : a.item === "core" ? "core" : "pages"); }
      else if (a.type === "layer") { setView("map"); setLayers((l) => ({ ...l, [a.layer]: a.on })); }
      else if (a.type === "here") { setView("map"); openHere(a.lon, a.lat); flyTo(a.lon, a.lat, a.zoom ?? 7); }
      else if (a.type === "analog") { setView("cosci"); setPanel("analogs"); setEntityId(null); setAnalogMode("rank"); setRefId(a.ref); setWeights(a.weights ? { ...DEFAULT_WEIGHTS, ...a.weights } as Weights : DEFAULT_WEIGHTS); }
      else if (a.type === "review") { setView("review"); setEntityId(null); setFilter({ ...DEFAULT_FILTER, type: a.filter as ReviewFilter["type"], basin: a.basin ?? "all" }); }
      else if (a.type === "score") { setView("evaluate"); setEntityId(null); if (a.qid) window.setTimeout(() => document.getElementById(`q-${a.qid}`)?.scrollIntoView({ block: "center" }), 60); }
      else if (a.type === "hypothesis") openHypothesis(a.id);
      else if (a.type === "filter") { setView("map"); setLayers((l) => ({ ...l, boreholes: true })); setBhFilter({ ...NO_FILTER, ...a.filter }); }
      else if (a.type === "sheet") { setSheetTab(a.tab); setView("data"); }
      else if (a.type === "view") { setView(a.view); if (a.sub) setKsub(a.sub); if (a.basin) setSelected(a.basin); }
      else if (a.type === "entity") { setView("knowledge"); if (a.sub) setKsub(a.sub); setEntityId(a.id); const n = g.nodes.get(a.id); if (n?.basin && BASINS.some((b) => b.id === n.basin)) setSelected(n.basin); }
      else if (a.type === "section") runPreset(a.preset);
      else if (a.type === "lens") setLens(a.id);
      else if (a.type === "cosci") openCosci(a.hyp);
      else if (a.type === "similar") similarTo(a.id);
      else if (a.type === "depthLens") { setView("map"); setLayers((l) => ({ ...l, depth: true })); setDepthLens(a.range); }
      else if (a.type === "docs") { setView("map"); setLayers((l) => ({ ...l, docs: a.on })); }
      else if (a.type === "ingest") openIngest();
      else if (a.type === "runtest") { setView("evaluate"); setEntityId(null); void runTestRef.current(); }
      else if (a.type === "lowc") { if (lens !== "lowc") setLens("lowc"); setPanel("lowc"); setEntityId(null); if (a.site) { setLcSite(a.site); setLcMode("evidence"); const s = siteById(a.site); if (s) flyTo(s.lon, s.lat, 7.5, s.name); } }
    }
  }, [doAsk, openWell, openHere, flyTo, g, lens, setLens, items, setDockOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // deep links: #ex=N opens the guided tour at that step; #view=evaluate opens a workspace; #tab=score still works; #lens=ds
  useEffect(() => {
    const h = window.location.hash;
    const ex = /ex=(\d+)/.exec(h); const t = /tab=(\w+)/.exec(h); const v = /view=(\w+)/.exec(h); const ln = /lens=(\w+)/.exec(h);
    if (ex) { const n = Math.min(EXERCISES.length, Math.max(1, Number(ex[1]))); setTrack((s) => ({ ...s, active: true, n, startedAt: s.startedAt ?? Date.now() })); }
    if (t && OLD_TABS.includes(t[1] as Tab)) goTab(t[1] as Tab);
    if (v && WORKSPACES.some(([k]) => k === v[1])) setView(v[1] as Workspace);
    if (ln && LENSES.some((l) => l.id === ln[1])) setLens(ln[1] as LensId);
    if (!rolePicked && !ex && !t && !v && !ln) setRoleOpen(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pickRole = (id: LensId, q?: string) => { setRolePicked(true); setRoleOpen(false); setLens(id); if (q) window.setTimeout(() => doAsk(q), 0); };
  const startTrack = () => { setRolePicked(true); setRoleOpen(false); setLensOpen(false); setTrack({ ...track, active: true, startedAt: track.startedAt ?? Date.now() }); };

  const decide = (e: Entity, status: "accepted" | "rejected" | "edited", label?: string) => {
    const prev = review[e.id];
    if (CLOUD) {
      const clear = prev?.status === status && status !== "edited";
      void cloud.decide(e.id, clear ? "clear" : status, label).then(() => refreshReviews()).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "The review could not be saved."));
      return;
    }
    if (prev?.status === status && status !== "edited") {
      setReview((r) => { const n = { ...r }; delete n[e.id]; return n; });
      setLog((l) => [{ at: now16(), by: reviewer, entity: e.id, action: `Cleared ${status}`, before: e.label, after: e.label, note: "" }, ...l]);
      return;
    }
    setReview((r) => ({ ...r, [e.id]: { status, label, at: now16(), by: reviewer } }));
    setLog((l) => [{ at: now16(), by: reviewer, entity: e.id, action: status === "accepted" ? "Accepted" : status === "rejected" ? "Rejected" : "Edited", before: prev?.label ?? e.label, after: status === "edited" ? label ?? "" : prev?.label ?? e.label, note: "" }, ...l]);
  };
  const saveOnService = (id: string, status: "accepted" | "edited", v?: string) =>
    void cloud.decide(id, status, v).then(() => refreshReviews()).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "The review could not be saved."));
  const reviewField = (s: Site, f: SiteField, d: "accepted" | "edited", v?: string) => {
    const id = `field:${s.siteId}:${f.fieldId}`; const before = `${f.label}: ${String(f.value)}${f.unit ? ` ${f.unit}` : ""}`;
    if (CLOUD) { saveOnService(id, d, v); return; }
    setReview((r) => ({ ...r, [id]: { status: d, label: v, at: now16(), by: reviewer } }));
    setLog((l) => [{ at: now16(), by: reviewer, entity: id, action: d === "accepted" ? "Accepted value" : "Corrected value", before, after: d === "edited" ? v ?? "" : before, note: s.name }, ...l]);
  };
  const reviewLcField = (s: LcSite, f: LcField, d: "approved" | "corrected", v?: string) => {
    const id = `lowc:${s.siteId}:${f.fieldId}`; const before = `${f.label}: ${String(f.value)}${f.unit ? ` ${f.unit}` : ""}`;
    if (CLOUD) { saveOnService(id, d === "approved" ? "accepted" : "edited", v); return; }
    setReview((r) => ({ ...r, [id]: { status: d === "approved" ? "accepted" : "edited", label: v, at: now16(), by: reviewer } }));
    setLog((l) => [{ at: now16(), by: reviewer, entity: id, action: d === "approved" ? "Accepted value" : "Corrected value", before, after: d === "corrected" ? v ?? "" : before, note: `${s.name} (Low-carbon lens)` }, ...l]);
  };
  const reviewedLabels = useMemo(() => Object.fromEntries(Object.entries(review).filter(([k]) => k.startsWith("field:") || k.startsWith("lowc:")).map(([k, r]) => [k.replace(/^lowc:[^:]+:/, ""), `${r.status === "accepted" ? "Accepted" : `Corrected to ${r.label}`} by ${r.by || "unnamed reviewer"} · ${r.at}`])), [review]);
  const onFinding = (id: string, action: string, title: string) => {
    setFindings((f) => ({ ...f, [id]: action }));
    setLog((l) => [{ at: now16(), by: reviewer, entity: `finding:${id}`, action: `Curation: ${action}`, before: title, after: action, note: "" }, ...l]);
  };

  const setEntry = (id: string, e: Partial<ScoreEntry>) => setScore((s) => ({ ...s, [id]: { ...(s[id] ?? {}), ...e } }));
  const onFeedback = (a: Answer5, vote: Vote, reason: Reason) => {
    if (CLOUD) void cloud.feedback({ answerId: a.id, question: a.question, vote, reason, citations: a.citations.map((c) => `${c.doc}${c.page ? ` p. ${c.page}` : ""}`), label: a.label })
      .then((r) => toast.success(r.note)).catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Feedback could not be sent."));
    const passages = a.label === "Retrieved" ? a.citations.map((c) => c.id).filter(rankable) : [];
    const effect = effectText(vote, reason, a.label, a.citations.map((c) => c.id));
    const f: Feedback = { id: `fb${Date.now().toString(36)}`, at: now16(), by: reviewer, q: a.question, terms: a.terms ?? tokenize(a.question), vote, reason, passages, label: a.label, effect };
    setFeedback((l) => [f, ...l].slice(0, 200)); setFeedbackStore([f, ...feedback]);
    setFbByAnswer((m) => ({ ...m, [a.id]: { vote, reason, effect } }));
    setLog((l) => [{ at: now16(), by: reviewer, entity: `answer: ${a.question.slice(0, 80)}`, action: vote === "up" ? "Feedback: useful" : `Feedback: ${reason.toLowerCase()}`, before: a.citations.map((c) => `${c.doc}${c.page ? ` p. ${c.page}` : ""}`).join("; "), after: effect, note: a.label }, ...l]);
  };
  const addToScore = (q: string) => { setCustom((c) => [...c, { q, dataType: "born-digital", level: "Integrate", key: "", evidence: [], id: `X${String(c.length + 1).padStart(2, "0")}`, custom: true }]); toast.success("Added to Evaluate"); };
  const runTest = async () => {
    if (running) return;
    const qs = allQuestions(custom); const rows: TestRow[] = []; const t0 = performance.now();
    for (let i = 0; i < qs.length; i++) {
      setRunning({ n: i + 1, of: qs.length }); await new Promise((r) => window.setTimeout(r, 0));
      const q = qs[i]; const a = CLOUD ? await cloud.ask(q.q, null).then(safeCloudReply).catch((e: unknown) => failureAnswer(q.q, e)) : answer5(q.q, { basin: null }); const c = autoCheck(q, a);
      rows.push({ id: q.id, q: q.q, label: a.label, source: c.source, facts: c.facts, ms: Math.round(a.ms ?? 0) });
    }
    const r: TestRun = { at: now16(), rows, totalMs: Math.round(performance.now() - t0), fb: feedback.filter((f) => f.vote === "up" || f.reason === "Wrong source").length, added: added.length };
    setTestRun(r); setRunning(null);
    setScore((s) => { const n = { ...s }; for (const x of rows) n[x.id] = { ...(n[x.id] ?? {}), label: x.label as AnswerLabel }; return n; });
    setAnswerMs((m) => [...m, ...rows.map((x) => x.ms)]);
    setLog((l) => [{ at: r.at, by: reviewer, entity: "test run", action: "Live test run", before: "", after: `${rows.length} questions, expected source cited ${rows.filter((x) => x.source).length} of ${rows.filter((x) => x.source != null).length}`, note: `${r.totalMs} ms` }, ...l]);
    toast.success(`Ran ${rows.length} questions in ${r.totalMs} ms`);
  };
  const runTestRef = useRef(runTest); runTestRef.current = runTest;
  const onIngested = (r: IngestResult) => {
    if (GATED && LICENCE.isWithheldIngestResult(r)) { toast.info("This evidence is withheld until its reuse terms are confirmed."); return; }
    registerPassages(r.passageList.map((x) => ({ id: x.id, doc: x.doc, page: x.page, h: x.h, t: x.t })));
    setAdded((x) => [...x, r]); setUserDocPts((x) => [...x, ...r.docPoints]); setKgVer((v) => v + 1);
    if (r.docPoints.length) setLayers((l) => ({ ...l, docs: true }));
    setLog((l) => [{ at: now16(), by: reviewer, entity: `doc:${r.docId}`, action: "Added a document", before: "", after: r.title, note: `${r.pages.length} of ${r.totalPages} pages read, ${r.entities.length} names, ${r.places.length} places, ${(r.ms.total / 1000).toFixed(1)} s` }, ...l]);
  };
  const onPropose = (name: string, doc: string, decision: "Accepted" | "Rejected") => setLog((l) => [{ at: now16(), by: reviewer, entity: `proposed: ${name}`, action: `New name ${decision.toLowerCase()}`, before: "", after: name, note: `From ${doc}` }, ...l]);
  const exportXlsx = () => {
    const rows = exportRows(questions, score, reviewer, review, log, PACK.entities, testRun);
    const about: [string, string][] = [["File", "GeoBasin Explorer AI scorecard export"], ["Original prototype built by", "Jorge Peña Alarcón, Microsoft"], ["Architected and enhanced into an Azure platform by", "Kim Vaddi, Microsoft"], ["Exported", now16()], ["Reviewer", reviewer || "not given"], ["Questions", String(questions.length)], ["Data", CLOUD ? "Retained public sources: Geoscience Australia, PEPS SA, World Stress Map, OzTemp and Natural Earth. GSQ CR000407, GSQ CR050039 and the 2026 SA DEM core workshop are withheld until reuse terms are confirmed." : "Public data only: Geoscience Australia (CC BY 4.0), PEPS SA (CC BY 4.0), Geological Survey of Queensland open file, World Stress Map 2025"], ["Answer labels", ABOUT_TEXT.labels], ["Levels", ABOUT_TEXT.levels], ["Marks", ABOUT_TEXT.marks]];
    try { downloadWorkbook(rows, about, `geobasin-explorer-ai-scorecard_${(reviewer || "reviewer").replace(/[^\w-]+/g, "-").slice(0, 30)}_${new Date().toISOString().slice(0, 10)}.xlsx`); toast.success("Scorecard exported to Excel"); }
    catch { toast.error("The export could not be created in this browser."); }
  };
  const saveAnswer = (a: Answer5) => {
    addNote.mutate({ kind: "Answer", title: a.question, note: a.paragraphs.join("\n").replace(/\*\*/g, ""), basin: basinById(a.basin)?.name ?? "", lon: a.focus?.lon ?? null, lat: a.focus?.lat ?? null, sources: sourceList(a).join("; ") }, { onSuccess: () => { setSavedIds((s) => new Set(s).add(a.id)); toast.success("Saved to notes"); } });
  };
  const saveAnalog = (ref: Play5, r: Ranked, lines: string[]) => {
    addNote.mutate({ kind: "Analog", title: `${r.play.play} (${r.play.province}) as an analog to ${ref.play}`, note: [`Score ${r.score}, coverage ${r.coverage}% (weights ${Object.entries(weights).map(([k, v]) => `${k} ${v}`).join(", ")})`, ...lines].join("\n"), basin: r.play.province, lon: null, lat: null, sources: `GA play-interval tables eCat ${ref.ecat} and ${r.play.ecat}` }, { onSuccess: () => { setSavedKeys((s) => new Set(s).add(`${ref.id}>${r.play.id}`)); toast.success("Rationale saved to notes"); } });
  };
  const saveHyp = (r: HResult) => {
    addNote.mutate({ kind: "Hypothesis", title: r.statement, note: [`Verdict: ${r.verdict}`, ...r.items.map((i) => `${i.stance}: ${i.text} (${i.source})`)].join("\n"), basin: "", lon: null, lat: null, sources: [...new Set(r.items.map((i) => i.source))].join("; ") }, { onSuccess: () => { setSavedHyp((x) => new Set(x).add(r.statement)); toast.success("Saved to notes"); } });
  };
  const saveCosci = (r: CoSciRun, rv: CoSciReview) => {
    const found = [...(r.engine?.lead ?? []).map((i) => ({ by: "lead", i })), ...r.agents.flatMap((o) => o.items.map((i) => ({ by: o.id as string, i })))];
    const items = found.map(({ by, i }) => `${by}, ${i.stance}: ${i.text} (${i.source})`);
    const engine = r.engine ? [`Foundry scientists: ${r.engine.label}. The validator judged ${r.engine.judged} and found ${r.engine.supported} supported; the checks removed ${r.engine.removed} before you saw ${r.engine.removed === 1 ? "it" : "them"}.`] : [];
    addNote.mutate({ kind: "Hypothesis", title: r.statement, note: [`Co-Scientist verdict: ${r.verdict}`, ...engine, `Your review: ${rv.decision}${rv.note ? `. ${rv.note}` : ""}`, ...items].join("\n"), basin: "", lon: null, lat: null, sources: [...new Set(found.map(({ i }) => i.source))].join("; ") },
      { onSuccess: () => toast.success("Saved to Notes and the change log") });
    setLog((l) => [{ at: now16(), by: rv.reviewer, entity: r.prepared ? `hyp:${r.prepared}` : "hyp:typed", action: `Co-Scientist review: ${rv.decision}`, before: r.verdict, after: rv.decision, note: `${r.statement}${rv.note ? ` · ${rv.note}` : ""}` }, ...l]);
  };
  const saveTag = () => {
    if (!tagAt) return; const b = BASINS.find((x) => x.id === (here?.basin ?? null));
    addNote.mutate({ kind: "Tag", title: tagTitle.trim() || "My tag", note: tagNote, basin: b?.name ?? "", lon: tagAt[0], lat: tagAt[1], sources: "Your tag, GDA94" }, { onSuccess: () => toast.success("Tag saved to Notes and shown on the map") });
    setTagAt(null); setTagTitle(""); setTagNote("");
  };
  const saveSection = () => {
    if (!section) return;
    addNote.mutate({ kind: "Section", title: `Section ${fmt(section.lengthKm)} km: ${section.basins.map((b) => b.name).join(", ") || "outside the four basins"}`,
      note: `A ${section.a[1].toFixed(3)}, ${section.a[0].toFixed(3)} to B ${section.b[1].toFixed(3)}, ${section.b[0].toFixed(3)}. Deepest basin floor ${section.maxDepth != null ? `${fmt(section.maxDepth)} m` : "not covered"}. ${section.boreholes.length} boreholes within 10 km; ${section.faults.length} faults crossed.`,
      basin: section.basins[0]?.name ?? "", lon: (section.a[0] + section.b[0]) / 2, lat: (section.a[1] + section.b[1]) / 2, sources: "GA depth-to-basement grids, borehole layers and fault traces (CC BY 4.0)" }, { onSuccess: () => toast.success("Section saved to notes") });
  };
  const pins: Pin[] = (noteRows.data?.rows ?? []).filter((n: NoteRow) => n.lon != null && n.lat != null).map((n) => ({ id: n.id, lon: n.lon!, lat: n.lat!, label: n.title }));
  // The map draws the path the spatial service measured (a geodesic), so the line and the numbers agree.
  const sectionPath = useMemo(() => (section?.engine === "gdal" ? section.pts.map((q): LonLat => [q.lon, q.lat]) : null), [section]);
  // Azure Maps keeps its logo and copyright line along the bottom edge, so the map's own overlays sit just above it.
  const mapBottom = mapEngine === "azure" ? "bottom-9" : "bottom-3";

  const trackScope = useShortcutScope("track");
  const skipKey = (e: KeyboardEvent) => !!(e.target as HTMLElement | null)?.closest("input, textarea, select, [role='tablist'], [role='dialog'], [role='slider'], [contenteditable]");
  useAppShortcut("right", (e) => { if (skipKey(e) || track.n >= EXERCISES.length) return; e.preventDefault(); setTrack({ ...track, n: track.n + 1 }); }, { scope: trackScope, enabled: track.active, preventDefault: false, description: "Next tour step" });
  useAppShortcut("left", (e) => { if (skipKey(e) || track.n <= 1) return; e.preventDefault(); setTrack({ ...track, n: track.n - 1 }); }, { scope: trackScope, enabled: track.active, preventDefault: false, description: "Previous tour step" });
  const hoverWell = hover?.site ? wellById(hover.site) ?? siteById(hover.site) : null;
  const med = answerMs.length ? [...answerMs].sort((a, b) => a - b)[Math.floor(answerMs.length / 2)] : null;
  const marked = Object.values(score).filter((s) => s.mark).length;
  const reviewed = Object.keys(review).length;
  const kpis: Record<LensId, Kpi[]> = {
    geo: [{ value: String(PACK.plays.length), label: "plays to compare" }, { value: "4", label: "prepared hypothesis tests" }, { value: String(items.length), label: "core images" }],
    lead: [{ value: "9", label: "capabilities in the file" }, { value: `${marked} of ${questions.length}`, label: "questions marked" }, { value: med != null ? `${Math.round(med)} ms` : "none yet", label: "median answer time" }],
    ds: GATED ? [{ value: String(PACK.benchmarks.length), label: "retained benchmark questions" }, { value: String(WELLS.reduce((n, w) => n + w.fields.length, 0)), label: "retained report values" }, { value: String(FLAGGED), label: "values flagged for review" }] : [{ value: "64", label: "test questions: all cited or Not found" }, { value: INN ? `${INN.stats.ocrMatch} of ${INN.stats.ocrCompared}` : "—", label: "old OCR matched page values" }, { value: String(FLAGGED), label: "values flagged for review" }],
    cs: [{ value: BH_TOTAL.toLocaleString("en-US"), label: "boreholes" }, { value: "60% · 32%", label: "passages with an outline · a point" }, { value: "GDA94", label: "every layer (EPSG:4283)" }],
    rpm: [{ value: `${reviewed} of ${PACK.entities.length}`, label: "entities reviewed" }, { value: String(g.edges.length.toLocaleString("en-US")), label: "graph links" }, { value: String(PACK.learning.length), label: "changes after testing" }],
    lowc: [{ value: String(SITES.length), label: "public wells" }, { value: "5 km", label: "temperature layer (OzTemp)" }, { value: String(CONTEXT.length), label: "CO₂ storage project" }],
  };
  const allDocPts = [...(docs?.points ?? []), ...userDocPts];
  const starters = [...new Set([...lensById(lens).questions, ...STARTERS])].filter((q) => !GATED || !LICENCE.referencesWithheld(q));
  // Suggestions follow the point the copilot is asked about, else the basin selected on the map, else the role.
  const suggested = suggestedQuestions(starters, { basin: CLOUD && nearScope && here ? here.basin : selected, place: CLOUD && nearScope && !!here });
  const basinName = selected ? basinById(selected)?.name ?? "Selected basin" : "All four basins";
  const role = lensById(lens).title;
  const copilotCtx: CopilotContext =
    view === "knowledge" ? { workspace: "Knowledge", place: (entityId && g.nodes.get(entityId)?.label) || basinName, detail: `Knowledge graph · ${g.nodes.size.toLocaleString("en-US")} entities · ${role}` }
    : view === "images" ? { workspace: "Images", place: imgQuery?.title ?? "Core photos and report figures", detail: `${items.length} images · look-alike search · ${role}` }
    : view === "cosci" ? { workspace: "Co-Scientist", place: "Hypothesis testing", detail: `Evidence for, against and missing · ${role}` }
    : view === "data" ? { workspace: "Data", place: "Documents and data", detail: `${added.length} added this session · ${ILLUSTRATIVE} illustrative values` }
    : view === "evaluate" ? { workspace: "Evaluate", place: "Founding benchmark", detail: `${questions.length} questions · ${marked} marked · ${role}` }
    : view === "review" ? { workspace: "Review", place: "Expert review", detail: `${reviewed} of ${PACK.entities.length} entities reviewed` }
    : { workspace: "Map", place: basinName, detail: `${Object.values(layers).filter(Boolean).length} layers on · ${layers.boreholes ? `${bhCount.n.toLocaleString("en-US")} boreholes` : "boreholes hidden"} · ${role}` };
  const placeScope = CLOUD && nearScope && here ? {
    text: `Answers about ${Math.abs(here.lat).toFixed(2)}°S ${here.lon.toFixed(2)}°E use what we know here and sources geotagged within ${NEAR_KM} km${here.basinName ? `, or about the ${here.basinName} as a whole` : ""}, and say so when a question needs the rest of the library.`,
    onClear: () => setNearScope(false),
  } : null;
  const askNear = () => { setNearScope(true); setDockOpen(true); setCopilotFocus((n) => n + 1); };
  const openAnalogs = (ref: string) => run([{ type: "analog", ref }]);
  const openField = (site: string, field: string) => (site === "core" ? run([{ type: "evidence", item: "core" }]) : openWell(site, field || undefined));
  const stageTop = 12 + barH + 6;
  const leftPad = track.active && view !== "map" && mapW >= 900 ? 412 : 0;
  const lcSiteObj = lcSite ? siteById(lcSite) : null;
  const stage = STAGE_VIEWS.includes(view);
  const toolBtn = "border-white/25 bg-brand-bar/90 text-white shadow-md hover:bg-brand-hover hover:text-white";
  const goWs = (k: Workspace) => { setView(k); if (k !== "map") { setSecPick(false); if (areaPick) clearArea(); } };
  const openData = (t: SheetTab) => { setSheetTab(t); setView("data"); };
  const onTabKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault(); const i = WORKSPACES.findIndex((w) => w[0] === view);
    const next = WORKSPACES[(i + (e.key === "ArrowRight" ? 1 : WORKSPACES.length - 1)) % WORKSPACES.length][0];
    goWs(next); window.requestAnimationFrame(() => document.getElementById(`ws-${next}`)?.focus());
  };
  const workspaceBar = (
    <div inert={behindSheet} className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/10 bg-brand-bar px-3 py-1.5 text-white">
      <div role="tablist" aria-label="Workspaces" onKeyDown={onTabKey} className="-mx-1 flex min-w-0 max-w-full items-center gap-0.5 overflow-x-auto px-1 py-0.5">
        {WORKSPACES.map(([k, label, Icon]) => (
          <button key={k} id={`ws-${k}`} type="button" role="tab" aria-selected={view === k} aria-controls="gbx-stage" tabIndex={view === k ? 0 : -1} onClick={() => goWs(k)}
            className={cn("flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white", view === k ? "relative bg-white text-brand after:absolute after:bottom-px after:left-1/2 after:h-0.5 after:w-4 after:-translate-x-1/2 after:rounded-full after:bg-brand-accent" : "text-white/90 hover:bg-white/10 hover:text-white")}>
            <Icon className="size-4" aria-hidden="true" />{label}
          </button>
        ))}
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
        <LensPicker lens={lens} setLens={setLens} />
        {!track.active && <Button type="button" size="sm" onClick={() => setTrack({ ...track, active: true, startedAt: track.startedAt ?? Date.now() })} aria-label="Start the guided tour" className="bg-white text-brand shadow-md hover:bg-white/90"><Play className="text-brand-highlight" aria-hidden="true" /><span className="2xl:hidden">Tour</span><span className="hidden 2xl:inline">Start the guided tour</span></Button>}
        <button type="button" onClick={() => openData("real")} className="flex h-8 items-center gap-1.5 rounded-md border border-white/25 px-2 text-xs font-medium text-white hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"><BookOpen className="size-3.5" aria-hidden="true" /> What's real <span className={cn("rounded px-1 font-semibold", STATUS_CLS.Illustrative)}>{ILLUSTRATIVE} illustrative</span></button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" className={toolBtn} aria-label="More options"><MoreHorizontal aria-hidden="true" /><span className="hidden 2xl:inline">More</span></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <DropdownMenuItem onSelect={openIngest}><FilePlus2 aria-hidden="true" /> Add a document</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => { setPanel("notes"); setEntityId(null); }}><NotebookText aria-hidden="true" /> Notes you saved</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked={showBuild} onCheckedChange={(v) => setShowBuild(!!v)}>How it's built (Microsoft services)</DropdownMenuCheckboxItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setRoleOpen(true)}>Pick a role again</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setAboutOpen(true)}><Info aria-hidden="true" /> About GeoBasin Explorer AI</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <button id={COPILOT_TOGGLE_ID} type="button" aria-expanded={dockOpen} aria-controls="gbx-copilot" aria-label={dockOpen ? "Close the exploration copilot" : "Open the exploration copilot"} onClick={() => setDockOpen(!dockOpen)}
          className={cn("flex h-8 items-center gap-1.5 rounded-full border pl-1 pr-3 text-sm font-semibold text-copilot-50 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-copilot-200", dockOpen ? "border-copilot-200/60 bg-copilot-300/15" : "border-copilot-200/40 bg-copilot-surface hover:border-copilot-200/70")}>
          <CopilotAvatar className="size-6" />Copilot
        </button>
      </div>
    </div>
  );
  const sideOpen = !!entityId || panel != null;
  const widths = panelWidths({ row: rowW, side: sideWPref, copilot: copilotWPref, sideOpen: sideOpen && lgUp, copilotOpen: dockOpen, docked: copilotMode === "docked" });
  const sideTitle = entityId ? g.nodes.get(entityId)?.label ?? "Entity" : panel ? PANEL_TITLE[panel] : "";
  /* When the side panel closes, or its content changes under the focus, move focus back to what opened it (or the
     workspace) instead of leaving it on the page body. */
  useEffect(() => {
    const was = sidePrev.current; sidePrev.current = sideOpen;
    if (sideOpen && !was) { const el = document.activeElement as HTMLElement | null; sideOpener.current = el && el !== document.body && !el.closest("#gbx-side") ? el : null; return; }
    if (!was) return;
    window.requestAnimationFrame(() => {
      if (document.activeElement && document.activeElement !== document.body) return;
      const back = sideOpener.current?.isConnected ? sideOpener.current : null;
      const target = sideOpen ? document.querySelector<HTMLElement>("#gbx-side header button") ?? document.getElementById("gbx-side") : back ?? document.getElementById("gbx-stage");
      if (!sideOpen) sideOpener.current = null;
      target?.focus({ preventScroll: true });
    });
  }, [sideOpen, entityId, panel]);
  const sidePanel = sideOpen ? (
    <aside id="gbx-side" tabIndex={-1} inert={behindSheet} aria-label={sideTitle} style={lgUp ? { width: widths.side } : undefined} className="relative flex min-h-0 w-full flex-col border-t bg-card max-lg:order-last lg:shrink-0 lg:border-r lg:border-t-0">
      {entityId ? <div className="min-h-0 flex-1 p-3"><EntityCard g={g} id={entityId} onSelect={selectEntity} onShow={showPlace} onAsk={(q) => doAsk(q)} onLineage={setLineageId} onTest={(h) => openCosci(h as HDef["id"])}
            onSimilar={similarTo} onClose={() => setEntityId(null)} review={review} onReview={(e, d) => decide(e, d)} className="h-full" /></div> : panel && <>
        <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
          <h2 className="text-sm font-semibold">{PANEL_TITLE[panel]}</h2>
          <Button type="button" size="icon" variant="ghost" className="size-7" aria-label={`Close ${PANEL_TITLE[panel]}`} onClick={() => setPanel(null)}><X aria-hidden="true" /></Button>
        </header>
        <div className="relative min-h-0 flex-1 overflow-y-auto p-3">
          {panel === "answers" && <>
            {fromQ && <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-dashed p-2 text-xs"><span>Asked from the scorecard ({fromQ}). Check the sources, then mark it.</span><Button type="button" size="xs" variant="secondary" onClick={() => run([{ type: "score", qid: fromQ }])}>Back to the question</Button></div>}
            <AskPanel compose={false} answers={answers} onAsk={(q) => doAsk(q)} onShow={showAnswer}
                onHit={showHit} onSave={saveAnswer} onAnalogs={openAnalogs} onOpenField={openField} showBuild={showBuild} inputId="ask-input" savedIds={savedIds}
                onGeo={showGeo} onOpenImage={openImage} onHypothesis={openHypothesis}
                starters={suggested} feedback={fbByAnswer} onFeedback={onFeedback} onAddDoc={openIngest} onAddToScore={addToScore} />
          </>}
          {panel === "analogs" && <div className="space-y-3">
              <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Analogs mode">
                {([["rank", "Rank analogs", ListOrdered], ["test", "Test a hypothesis", FlaskConical]] as const).map(([k, label, Icon]) => (
                  <button key={k} type="button" aria-pressed={analogMode === k} onClick={() => setAnalogMode(k)} className={cn("flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring", analogMode === k ? "bg-background shadow-sm" : "text-muted-foreground hover:text-foreground")}><Icon className="size-4" aria-hidden="true" />{label}</button>
                ))}
              </div>
              {analogMode === "rank"
                ? <AnalogPanel refId={refId} setRefId={setRefId} weights={weights} setWeights={setWeights} onShowPlay={showPlay} onSave={saveAnalog} showBuild={showBuild} savedKeys={savedKeys} />
                : <><HypothesisPanel refId={refId} weights={weights} choice={hypChoice} setChoice={setHypChoice} result={hypResult} setResult={setHypResult} onAsk={(q) => doAsk(q)} onOpen={openImage} onSave={saveHyp} showBuild={showBuild} saved={!!hypResult && savedHyp.has(hypResult.statement)} />
                  <Button type="button" size="sm" variant="secondary" className="w-full" onClick={() => openCosci(hypChoice === "custom" ? undefined : hypChoice as HDef["id"])}><FlaskConical aria-hidden="true" /> Run the Co-Scientist agents on it</Button></>}
          </div>}
          {panel === "evidence" && <EvidencePanel item={evItem} setItem={(i) => { setEvItem(i); setFocusField(null); }} focusField={focusField} showBuild={showBuild} reviewed={reviewedLabels} onReview={reviewField} onShowWell={(s) => { setView("map"); flyTo(s.lon, s.lat, 8.2, s.name); }} onAsk={(q) => doAsk(q)} />}
          {panel === "notes" && <NotesPanel onShow={(n) => { if (n.lon != null && n.lat != null) { setView("map"); flyTo(n.lon, n.lat, 8, n.title); } }} />}
          {panel === "lowc" && lowc && <div className="space-y-3">
              <div className="rounded-lg border border-dashed p-2 text-xs"><span className="font-semibold">Secondary lens.</span> {GATED ? ` CO₂ storage and geothermal screening on ${SITES.length} retained public wells. Exploration stays first.` : " CO₂ storage and geothermal screening on four public wells. Exploration stays first."}</div>
              <div className="flex flex-wrap gap-1" role="group" aria-label="Low-carbon wells">
                <button type="button" aria-pressed={!lcSite} onClick={() => { setLcSite(null); setLcMode("screen"); }} className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", !lcSite ? "border-brand bg-brand text-white" : "hover:bg-muted")}>All wells</button>
                {SITES.map((s) => <button key={s.siteId} type="button" aria-pressed={lcSite === s.siteId} onClick={() => run([{ type: "lowc", site: s.siteId }])} className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium", lcSite === s.siteId ? "border-brand bg-brand text-white" : "hover:bg-muted")}>{s.name}</button>)}
              </div>
              {lcSiteObj && <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1" role="group" aria-label="Low-carbon view">
                {(["screen", "evidence"] as const).map((m) => <button key={m} type="button" aria-pressed={lcMode === m} onClick={() => setLcMode(m)} className={cn("rounded-md px-2 py-1 text-sm font-medium", lcMode === m ? "bg-background shadow-sm" : "text-muted-foreground")}>{m === "screen" ? "Screen" : "Evidence"}</button>)}</div>}
              {lcSiteObj && lcMode === "evidence"
                ? <LcEvidencePanel site={lcSiteObj} showBuild={showBuild} focusField={null} onReview={reviewLcField} canReview reviewed={reviewedLabels} reviewing={false} />
                : <ScreeningPanel site={lcSiteObj} lens={lcLens} onLens={setLcLens} onSelectSite={(id) => run([{ type: "lowc", site: id }])} onOpenField={(sid) => { setLcSite(sid); setLcMode("evidence"); }} showBuild={showBuild} />}
          </div>}
        </div>
      </>}
      {lgUp && <ResizeHandle panelId="gbx-side" edge="right" label="Resize the side panel" width={widths.side} min={PANEL_MIN} max={widths.sideMax}
        onResize={setSideWPref} onReset={() => setSideWPref(null)} className="z-30" lineClassName="group-hover:bg-ring/50 group-focus-visible:bg-ring group-data-[dragging=true]:bg-ring" />}
    </aside>
  ) : null;
  const pageBox = "absolute inset-0 overflow-y-auto bg-[#F5F5FA] text-foreground";
  const pages = (
    <>
      {view === "data" && <div className={pageBox} style={{ paddingLeft: leftPad }}><div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <header className="space-y-1"><h1 className="text-xl font-semibold tracking-tight">Data</h1><p className="text-sm text-muted-foreground">Read public documents into search, the map and the knowledge graph, then check what's real, how it was loaded and how it was checked.</p></header>
        <section aria-labelledby="add-doc-h" className="space-y-2 rounded-xl border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 id="add-doc-h" className="text-base font-semibold">Add a document</h2>{!uploadsPaused && <Button type="button" onClick={openIngest}><FilePlus2 aria-hidden="true" /> Add a document</Button>}</div>
          <p className="text-sm">{uploadsPaused ? BRAND.uploadsPaused : <>{CLOUD ? "Upload a public PDF or image. It is scanned for malware, read with Azure Document Intelligence (scanned pages included), and added to your own library. " : "Read a public PDF in this browser. "}Every page is accounted for, failures are named, and names and places are linked to the knowledge graph and the map with a confidence.</>}</p>
          {added.length ? <ul className="space-y-1 text-sm">{added.map((r) => <li key={r.docId} className="rounded-lg border px-2.5 py-1.5"><span className="font-medium">{r.title}</span><span className="text-muted-foreground"> · {r.pages.length} of {r.totalPages} pages read · {r.entities.length} names · {r.places.length} places · {(r.ms.total / 1000).toFixed(1)} s</span></li>)}</ul>
            : !uploadsPaused && <p className="text-xs text-muted-foreground">No documents added in this session yet.{!CLOUD && GATED ? "" : " The bundled public sample report is a good first try."}</p>}
        </section>
        <DataSheet tab={sheetTab} setTab={setSheetTab} showBuild={showBuild} appMs={appMs} answerMs={answerMs} added={added} feedback={feedback} overlays={!!planetary?.enabled} onClearFeedback={() => { setFeedback([]); setFeedbackStore([]); setFbByAnswer({}); toast("Feedback cleared. Rankings are back to the defaults."); }} />
      </div></div>}
      {view === "evaluate" && <div className={pageBox} style={{ paddingLeft: leftPad }}><div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <header className="space-y-1"><h1 className="text-xl font-semibold tracking-tight">Evaluate</h1><p className="text-sm text-muted-foreground">The founding benchmark: twelve scientist questions with answer keys and expected sources, plus any you add. Ask each one, check its sources, mark it, run the live test and export the scorecard.</p></header>
        <div className="rounded-xl border bg-card p-4"><ScorePanel questions={questions} score={score} setEntry={setEntry} reviewer={reviewer} setReviewer={setReviewer} onAsk={(q) => doAsk(q.q, q.id)} storageOk={STORAGE_OK}
                onAdd={(q) => setCustom((c) => [...c, { ...q, id: `X${String(c.length + 1).padStart(2, "0")}`, custom: true }])}
                onRemove={(id) => setCustom((c) => c.filter((x) => x.id !== id))}
                onExport={exportXlsx}
                onReset={async () => { if (await confirm({ title: "Clear all marks?", description: "Marks, levels, evidence and notes on every question are removed from this browser. Export first if you need them.", confirmLabel: "Clear marks", destructive: true })) setScore({}); }}
                showBuild={showBuild} onRunTest={() => void runTest()} testRun={testRun} running={running} /></div>
      </div></div>}
      {view === "review" && <div className={pageBox} style={{ paddingLeft: leftPad }}><div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        <header className="space-y-1"><h1 className="text-xl font-semibold tracking-tight">Review</h1><p className="text-sm text-muted-foreground">Accept, correct or reject what was extracted into the knowledge graph. Every decision is logged with your name and the time, and the change log goes into the Excel export.</p></header>
        {CLOUD && service?.owner && LiveReviewPanel && <Suspense fallback={<p role="status">Loading steward review…</p>}><LiveReviewPanel owner onPublished={refreshPublication} /></Suspense>}
        <div className="rounded-xl border bg-card p-4"><ReviewPanel reviewer={reviewer} setReviewer={setReviewer} review={review} log={log} filter={filter} setFilter={setFilter} onDecide={decide} onShow={(e) => { if (e.lonlat) { setView("map"); flyTo(e.lonlat[0], e.lonlat[1], e.type === "basin" ? 6 : 8, e.label); } }} showBuild={showBuild} /></div>
      </div></div>}
    </>
  );
  const copilot = (
    <CopilotPanel mode={copilotMode} open={dockOpen} onOpenChange={setDockOpen} context={copilotCtx} starters={suggested} progress={askProgress}
      answers={answers} onClear={() => { setAnswers([]); setPanel((cur) => (cur === "answers" ? null : cur)); }}
      onAsk={(q) => doAsk(q, undefined, { keepPanel: true })} onShow={showAnswer} onOpenFull={openFullAnswer} onOpenAnswers={() => openFullAnswer()}
      onHypothesis={openHypothesis} onAddDoc={openIngest} onAnalogs={openAnalogs} onOpenField={openField} service={service}
      focusSignal={copilotFocus} scope={placeScope}
      size={{ width: widths.copilot, min: PANEL_MIN, max: widths.copilotMax, onResize: setCopilotWPref, onReset: () => setCopilotWPref(null) }} />
  );

  return (
    <div {...trackScope.bindings} className="flex flex-col max-lg:min-h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-3.5rem)] lg:overflow-hidden">
      {workspaceBar}
      {!STORAGE_OK && <p role="status" className="border-b bg-amber-50 px-3 py-1.5 text-xs text-amber-950">This browser is not saving data for local files. Scores and reviews last until you close the tab: export before you leave.</p>}
      <div ref={rowRef} className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
      {sidePanel}
      <section ref={mapRef} id="gbx-stage" tabIndex={-1} inert={behindSheet} role="tabpanel" aria-labelledby={`ws-${view}`} className={cn("relative min-h-[460px] overflow-hidden bg-brand-stage focus:outline-none lg:h-auto lg:min-w-0 lg:flex-1", sideOpen ? "h-[62dvh]" : "max-lg:flex-1")}>
        <div className={cn("absolute inset-0", view !== "map" && "invisible")} aria-hidden={view !== "map"}>
{(() => {
            const mp: BasinMapProps = {
              selected, fly, highlight, pins, activePin: null, layers, tagMode: false,
              sites: CLOUD ? liveMapMarkers(lowc ? [...MARKERS, ...LC_MARKERS] : MARKERS, publicationView) : lowc ? [...MARKERS, ...LC_MARKERS] : MARKERS, activeSite: evItem && wellById(evItem) ? evItem : lcSite, overlay: PACK.confOverlay, seismic: SEISMIC, here: here ? { lon: here.lon, lat: here.lat } : null, bhFilter,
              depthLens, docPoints: allDocPts, activeDoc, onSelectDoc: (id) => { setHere(null); setActiveDoc(id); },
              section: secA ? { a: secA, b: section?.b ?? null } : null, sectionPath, sectionPick: secPick, onSectionPick: pickSection, tempOverlay: lowc ? TEMP : null,
              area: areaPick || area ? { pts: area ? area.ring : areaPts, closed: !!area } : null, areaPick, onAreaPick: pickArea, onAreaFinish: finishArea,
              onContextPick: (lon, lat) => { setTagAt([lon, lat]); },
              controlRef: control, onEngine: setMapEngine, onBaseMap: setBaseMap, onOverlayOff: () => setPcId(""),
              onSelectSite: (id) => { if (CLOUD && id === "marabooka-1" && (publicationView.sources.some((s) => s.sourceId === "peps-sa-marabooka-1") || publicationView.requiredSourceIds.includes("peps-sa-marabooka-1"))) { setLiveSourceOpen(true); return; } if (SITES.some((s) => s.siteId === id) && lowc && !wellById(id)) run([{ type: "lowc", site: id }]); else if (CONTEXT.some((c) => c.id === id)) run([{ type: "lowc" }]); else openWell(id); },
              onSelectBasin: (id) => setSelected(id),
              onSelectBorehole: (b) => openHere(b.lon, b.lat),
              onSelectPin: () => { setPanel("notes"); setEntityId(null); },
              onPick: () => undefined,
              onPickHere: (lon, lat) => openHere(lon, lat),
              onHover: setHover,
            };
            return AzureBasinMap
              ? <Suspense fallback={<div role="status" className="absolute inset-0 grid place-items-center bg-brand-stage text-sm text-white/70">Loading Azure Maps…</div>}><AzureBasinMap {...mp} /></Suspense>
              : <BasinMap {...mp} />;
          })()}
        </div>
        {view === "knowledge" && <div className="absolute inset-0" style={{ paddingLeft: leftPad }}><div className="relative h-full">
          <KnowledgeStage key={`kg${kgVer}`} g={g} sub={ksub} setSub={setKsub} basin={selected ?? "cooper"} sel={entityId} onSelect={setEntityId} ccs={lowc} topPad={stageTop}
            onFinding={onFinding} findingState={findings} onOpenReview={() => { setView("review"); setEntityId(null); }} showBuild={showBuild} /></div></div>}
        {view === "images" && <div className="absolute inset-0" style={{ paddingLeft: leftPad }}><div className="relative h-full">
          <ImagesStage items={items} topPad={stageTop} query={imgQuery} setQuery={setImgQuery} sel={imgSel} showBuild={showBuild}
            onSelect={(it) => { setImgSel(it.id); if (it.nodeId) setEntityId(it.nodeId); else toast(`${it.title}. Source: ${it.source}`); }} /></div></div>}
        {view === "cosci" && <div className="absolute inset-0" style={{ paddingLeft: leftPad }}><div className="relative h-full">
          <CoSciStage topPad={stageTop} hyp={cosciHyp} setHyp={setCosciHyp} ctx={{ refId, weights }} onAsk={(q) => doAsk(q)} onSave={saveCosci} reviewer={reviewer} setReviewer={setReviewer} showBuild={showBuild} scientists={!!service?.scientists}
            onOpenImages={(title) => { const it = items.find((x) => x.title === title || title.includes(x.unit ?? "~")); if (it) similarTo(it.id); else setView("images"); }} onSelectEntity={(id) => setEntityId(id)} /></div></div>}
        {pages}
        {view !== "map" && stage && <div className="absolute inset-x-0 top-0 z-10 bg-brand" style={{ height: stageTop }} aria-hidden="true" />}
        <div ref={barRef} role="group" aria-label="Workspace tools" className={cn("pointer-events-none absolute inset-x-3 top-3 z-20 flex flex-wrap items-start justify-between gap-2", !stage && "hidden")}>
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button type="button" size="sm" variant="outline" className="rounded-full border-white/25 bg-brand-bar/90 text-white shadow-md hover:bg-brand-hover hover:text-white" aria-label={`Basin: ${basinById(selected)?.short ?? "all four"}. Change basin`}>Basin: {basinById(selected)?.short ?? "All four"}<ChevronDown aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Go to a basin</DropdownMenuLabel>
                <DropdownMenuItem onSelect={() => { setSelected(null); setView("map"); control.current?.reset(); }}>All four basins</DropdownMenuItem>
                {BASINS.map((b) => <DropdownMenuItem key={b.id} onSelect={() => { setSelected(b.id); if (view === "map") flyTo(b.labelAt[0], b.labelAt[1], 6.2); }}>{b.name}</DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>
            {view === "map" && mapEngine === "azure" && esri?.enabled && <div role="group" aria-label="Map provider" data-gbx-map-provider={provider} className="flex h-8 items-center rounded-full border border-white/25 bg-brand-bar/90 p-0.5 shadow-md">
              {(["azure", "esri"] as const).map((k) => <button key={k} type="button" aria-pressed={provider === k} onClick={() => chooseProvider(k)}
                title={k === "azure" ? "Base map from Azure Maps" : "Base map from Esri ArcGIS (imagery or relief)"}
                className={cn("h-7 rounded-full px-3 text-xs font-medium text-white/85 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white", provider === k && "bg-white text-brand-bar hover:text-brand-bar")}>{k === "azure" ? "Azure Maps" : "Esri ArcGIS"}</button>)}
            </div>}
          </div>
          <div className="pointer-events-auto flex flex-wrap justify-end gap-1.5">
            {view === "map" && <Popover>
              <PopoverTrigger asChild><Button type="button" size="sm" variant="outline" className="border-white/25 bg-brand-bar/90 text-white shadow-md hover:bg-brand-hover hover:text-white"><Layers aria-hidden="true" /> Layers</Button></PopoverTrigger>
              <PopoverContent align="end" className="max-h-[80dvh] w-80 space-y-2.5 overflow-y-auto">
                <p className="text-sm font-semibold">Map layers</p>
                {CLOUD && publicationLabel && <p className="text-xs" data-live-map-status="true">{publicationLabel}</p>}
                {[...LAYER_LABELS, ...(lowc ? [["temp", "Temperature at 5 km (Low-carbon)"] as [keyof MapLayers, string]] : [])].map(([k, label]) => <div key={k} className="flex items-center justify-between gap-3"><Label htmlFor={`layer-${k}`} className="text-sm font-normal">{label}</Label><Switch id={`layer-${k}`} checked={layers[k]} onCheckedChange={(v) => setLayers((l) => ({ ...l, [k]: v }))} /></div>)}
                {layers.docs && <p className="text-xs text-muted-foreground">{docs ? `${docs.points.length} places carry ${docs.total - docs.general} place-specific passages; ${docs.general} general passages have no place. Click a document marker to read them.` : "Placing the passages…"}</p>}
                <div className="space-y-1.5 border-t pt-2">
                  <div className="flex items-center justify-between gap-3"><Label htmlFor="d-lens" className="text-sm font-semibold">Depth lens</Label><Switch id="d-lens" checked={!!depthLens} onCheckedChange={(v) => { setDepthLens(v ? [3000, 11000] : null); if (v) setLayers((l) => ({ ...l, depth: true })); }} /></div>
                  {depthLens && <div className="space-y-1"><div className="flex justify-between text-xs"><span>Basin floor between</span><span className="tabular-nums">{fmt(depthLens[0])}–{fmt(depthLens[1])} m</span></div>
                    <Slider aria-label="Depth lens" thumbLabels={["Shallowest floor shown", "Deepest floor shown"]} min={0} max={11000} step={250} value={depthLens} onValueChange={(v) => setDepthLens([v[0], v[1]])} />
                    <p className="text-xs text-muted-foreground">Floor outside the range is greyed out. Source: GA depth-to-basement grids.</p></div>}
                </div>
                <div className="space-y-2 border-t pt-2">
                  <p className="text-sm font-semibold">Filter boreholes</p>
                  <div className="space-y-1"><div className="flex justify-between text-xs"><Label htmlFor="f-td" className="text-xs font-normal">Deeper than</Label><span className="tabular-nums">{bhFilter.minTd ? `${bhFilter.minTd.toLocaleString("en-US")} m` : "any depth"}</span></div>
                    <Slider id="f-td" aria-label="Minimum total depth" min={0} max={5000} step={250} value={[bhFilter.minTd]} onValueChange={(v) => setBhFilter((f) => ({ ...f, minTd: v[0] }))} /></div>
                  <div className="space-y-1"><div className="flex justify-between text-xs"><span>Drilled between</span><span className="tabular-nums">{bhFilter.y0}–{bhFilter.y1}</span></div>
                    <Slider aria-label="Years drilled" thumbLabels={["Drilled from", "Drilled to"]} min={YEAR_MIN} max={YEAR_MAX} step={5} value={[bhFilter.y0, bhFilter.y1]} onValueChange={(v) => setBhFilter((f) => ({ ...f, y0: v[0], y1: v[1] }))} /></div>
                  <div className="flex items-center justify-between gap-3"><Label htmlFor="f-in" className="text-xs font-normal">Inside basin outlines only</Label><Switch id="f-in" checked={bhFilter.insideOnly} onCheckedChange={(v) => setBhFilter((f) => ({ ...f, insideOnly: v }))} /></div>
                  <p className="text-xs tabular-nums" aria-live="polite">{filterOn(bhFilter) ? `${bhCount.n.toLocaleString("en-US")} of ${bhCount.all.toLocaleString("en-US")} boreholes match` : `${bhCount.all.toLocaleString("en-US")} boreholes, no filter`}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Button type="button" size="xs" variant="ghost" disabled={!filterOn(bhFilter)} onClick={() => setBhFilter(NO_FILTER)}><RotateCcw aria-hidden="true" /> Clear filter</Button>
                    <Button type="button" size="xs" variant="outline" onClick={() => { setSheetTab("checks"); setView("data"); }}><ShieldCheck aria-hidden="true" /> Spatial checks</Button>
                  </div>
                </div>
                {provider === "esri" && mapEngine === "azure" && planetary?.enabled && <fieldset className="space-y-1.5 border-t pt-2" data-gbx-planetary>
                  <legend className="text-sm font-semibold">Planetary Computer overlay</legend>
                  <p className="text-xs text-muted-foreground">Copernicus satellite imagery and elevation over the Cooper Basin, from Microsoft Planetary Computer Pro. The overlay covers the Esri base map and the depth tint, so lower its opacity to see them through it.</p>
                  {[{ id: "", label: "None" }, ...planetary.layers].map((l) => <label key={l.id || "none"} className="flex items-center gap-2 text-sm">
                    <input type="radio" name="gbx-planetary" value={l.id} checked={pcId === l.id} onChange={() => setPcId(l.id)} className="size-3.5" />{l.label}</label>)}
                  {pcLayer && <div className="space-y-1"><div className="flex justify-between text-xs"><span>Opacity</span><span className="tabular-nums">{pcOpacity}%</span></div>
                    <Slider aria-label="Overlay opacity" min={20} max={100} step={5} value={[pcOpacity]} onValueChange={(v) => setPcOpacity(v[0])} /></div>}
                </fieldset>}
                <p className="text-xs text-muted-foreground">All layers are GDA94 geographic (EPSG:4283). Click anywhere on the map to see what we know there. Right-click to tag a spot.</p>
              </PopoverContent>
            </Popover>}
            {view === "map" && <Button type="button" size="sm" variant="outline" className={toolBtn} aria-pressed={panel === "evidence"} onClick={() => { setPanel(panel === "evidence" ? null : "evidence"); setEntityId(null); }}><FileSearch aria-hidden="true" /> Evidence</Button>}
            {view === "map" && lowc && <Button type="button" size="sm" variant="outline" className={toolBtn} aria-pressed={panel === "lowc"} onClick={() => { setPanel(panel === "lowc" ? null : "lowc"); setEntityId(null); }}><Leaf aria-hidden="true" /> Low-carbon</Button>}
            {view === "cosci" && <Button type="button" size="sm" variant="outline" className={toolBtn} aria-pressed={panel === "analogs"} onClick={() => { setPanel(panel === "analogs" ? null : "analogs"); setEntityId(null); }}><ListOrdered aria-hidden="true" /> Analogs</Button>}
            {showBuild && <span className="rounded-md border border-white/25 bg-brand-bar/90 px-2 py-1 text-xs text-white shadow-md">How it's built: on</span>}
          </div>
        </div>
        {(() => {
          const top = stageTop + 2; const side = (track.active || lensOpen) && mapW >= 820;
          const hereCard = view === "map" && here ? <HereCard info={here} showBuild={showBuild} onClose={() => setHere(null)} onFly={(lon, lat) => flyTo(lon, lat, 9)} onOpenWell={(id) => openWell(id)} onTag={() => setTagAt([here.lon, here.lat])} onSection={() => startSection([here.lon, here.lat])} onAskNear={CLOUD ? askNear : undefined} /> : null;
          const docPt = view === "map" && activeDoc ? allDocPts.find((d) => d.id === activeDoc) ?? null : null;
          const docCard = docPt ? <DocsHereCard pt={docPt} onClose={() => setActiveDoc(null)} onAsk={(q) => doAsk(q)} /> : null;
          const areaCard = view === "map" && area ? <AreaCard info={area} onClose={clearArea} onFly={(lon, lat) => flyTo(lon, lat, 9)} onOpenWell={(id) => openWell(id)} onZoom={zoomToArea}
            onHighlight={highlightArea} highlighted={!!areaHl.current && highlight === areaHl.current} onSave={saveArea} onRedraw={startArea} /> : null;
          const right = areaCard ?? hereCard ?? docCard;
          const lensCard = lensOpen && !track.active && view === "map" ? <LensCard lens={lens} kpis={kpis[lens]} run={run} onAsk={(q) => doAsk(q)} onClose={() => setLensOpen(false)} maxHeight={Math.max(260, mapH - top - 96)} /> : null;
          /* The card opens in a window that docks on the right, beside the map's controls, when the track or a lens card
             is open on a wide map, and otherwise at the top left under whatever is open there. Once it has been moved or
             resized it opens where it was left, kept inside the map, until a double-click puts it back (map-window.tsx). */
          const stage = { w: mapW, h: mapH, top }, saved = asRect(winPref);
          const winW = Math.min(docCard && !areaCard && !hereCard ? 340 : 380, mapW - 24);
          const winRect = clampRect(saved ?? { x: side ? mapW - 56 - winW : 12, y: side || !leftColH ? top : top + leftColH + 8, w: winW }, stage);
          return (
            <>
              <div ref={leftColRef} className="pointer-events-none absolute left-3 z-30 flex flex-col gap-2 overflow-y-auto" style={{ top, maxHeight: `calc(100% - ${top + 12}px)` }}>
                {track.active && <TrackCard st={track} setSt={setTrack} run={run} onClose={() => setTrack({ ...track, active: false })} maxHeight={Math.max(260, (mapH - top - 96) * (!side && right && !saved ? 0.55 : 1))} />}
                {lensCard}
              </div>
              {right && <MapWindow label={areaCard ? "What we know in this area" : hereCard ? "What we know here" : "Tagged documents"} rect={winRect} bottomGap={side ? 128 : 12}
                stage={stage} onChange={setWinPref} onReset={() => setWinPref(null)}>{right}</MapWindow>}
            </>
          );
        })()}
        {view === "map" && secPick && <div role="status" className="absolute left-1/2 top-[88px] z-30 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[#C2410C] px-3 py-1.5 text-sm font-medium text-white shadow-lg">{secA ? "Click the end point (B)" : "Click the start point (A)"}<button type="button" className="rounded-full bg-white/20 px-2 text-xs hover:bg-white/30" onClick={() => { setSecPick(false); setSecA(section ? section.a : null); }}>Cancel</button></div>}
        {view === "map" && areaPick && <div role="status" data-gbx-area-banner className="absolute left-1/2 top-[88px] z-30 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-2 rounded-2xl bg-cyan-800 px-3 py-1.5 text-sm font-medium text-white shadow-lg">
          <span>{areaPts.length === 0 ? "Click the map to place the first corner of the area" : areaPts.length < 3 ? `Click to place more corners (${areaPts.length} so far)` : "Double-click, or click the first corner, to finish"}</span>
          <button type="button" className="rounded-full bg-white/20 px-2 text-xs hover:bg-white/30 disabled:opacity-50" disabled={!areaPts.length} onClick={() => setAreaPts((p) => p.slice(0, -1))}>Undo</button>
          <button type="button" className="rounded-full bg-white/20 px-2 text-xs hover:bg-white/30 disabled:opacity-50" disabled={areaPts.length < 3} onClick={finishArea}>Finish</button>
          <button type="button" className="rounded-full bg-white/20 px-2 text-xs hover:bg-white/30" onClick={clearArea}>Cancel</button>
        </div>}
        {view === "map" && section && <div className={cn("absolute z-20", mapBottom)} style={{ right: 64, left: track.active && mapW >= 900 ? 424 : 12 }}><SectionSheet s={section} showBuild={showBuild} onClose={closeSection} onPreset={runPreset} onSave={saveSection} onBorehole={(key) => { const [bid, i] = key.split(":"); const w = BASINS.find((b) => b.id === bid)?.boreholes[Number(i)]; if (w) openHere(w.lon, w.lat); }} /></div>}
        {view === "map" && !section && <div className={cn("pointer-events-none absolute left-3 flex max-w-[calc(100%-5rem)] flex-col items-start gap-2", mapBottom)}>
          {((layers.conf && PACK.confOverlay) || (lowc && layers.temp) || pcLayer?.legend) && <div className="hidden flex-wrap gap-2 sm:flex">
            {layers.conf && PACK.confOverlay && (
              <div className="w-56 rounded-lg border border-white/15 bg-brand-bar/85 p-2 text-white backdrop-blur">
                <p className="text-xs font-semibold">GA data confidence</p>
                <div className="mt-1 h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${PACK.confOverlay.stops.join(", ")})` }} aria-hidden="true" />
                <div className="mt-0.5 flex justify-between text-[11px]"><span>Less control</span><span>More control</span></div>
                <p className="text-[10px] text-white/80">Borehole and seismic confidence, ranked within each basin (GA grids)</p>
              </div>
            )}
            {lowc && layers.temp && (
              <div className="w-56 rounded-lg border border-white/15 bg-brand-bar/85 p-2 text-white backdrop-blur">
                <p className="text-xs font-semibold">Temperature at 5 km (OzTemp)</p>
                <div className="mt-1 h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${OZTEMP.legend.map((s) => s.color).join(", ")})` }} aria-hidden="true" />
                <div className="mt-0.5 flex justify-between text-[11px]"><span>{OZTEMP.legend[0].tempC} °C</span><span>{OZTEMP.legend[OZTEMP.legend.length - 1].tempC} °C</span></div>
                <p className="text-[10px] text-white/80">GA, continental scale. Read as 25 °C bands.</p>
              </div>
            )}
            {pcLayer?.legend && (
              <div className="w-56 rounded-lg border border-white/15 bg-brand-bar/85 p-2 text-white backdrop-blur" data-gbx-planetary-legend>
                <p className="text-xs font-semibold">{pcLayer.legend.title}</p>
                <div className="mt-1 h-2 rounded-full" style={{ background: `linear-gradient(90deg, ${pcLayer.legend.colors.join(", ")})` }} aria-hidden="true" />
                <div className="mt-0.5 flex justify-between text-[11px]"><span>{pcLayer.legend.min}</span><span>{pcLayer.legend.max}</span></div>
                <p className="text-[10px] text-white/80">Cooper Basin only, from Microsoft Planetary Computer Pro.</p>
              </div>
            )}
          </div>}
          {/* Where the pointer is, only while it is over the map. */}
          <div className={hover ? "rounded-lg border border-white/15 bg-brand-bar/85 px-2.5 py-1.5 text-xs text-white backdrop-blur" : "sr-only"} aria-live="polite">
            {hover && (hoverWell ? <span><span className="font-semibold">{hoverWell.name}</span> · scanned report · click to open</span>
              : <span>{Math.abs(hover.lat).toFixed(3)}°S {hover.lon.toFixed(3)}°E (GDA94){hover.basin && <> · {hover.basin} · floor {depthLabel(hover.depth)}</>}</span>)}
          </div>
          {/* The data credits, which CC BY 4.0 requires, stay on the map one click away rather than in a standing bar. */}
          <Popover>
            <PopoverTrigger asChild><button type="button" className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-white/15 bg-brand-bar/85 px-2.5 py-1 text-xs text-white backdrop-blur hover:bg-brand-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"><Info className="size-3.5" aria-hidden="true" />Data credits</button></PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-80 space-y-1.5 text-xs" data-gbx-map-credits>
              <p>Geology © Geoscience Australia (CC BY 4.0) · Well reports PEPS SA (CC BY 4.0) and GSQ open file · World Stress Map 2025{mapEngine === "canvas" ? " · Natural Earth" : ""}{lowc ? " · OzTemp (GA)" : ""}</p>
              <p className="text-muted-foreground">Every source and its licence is listed in the Data sheet, in the Data workspace.</p>
            </PopoverContent>
          </Popover>
        </div>}
        {view === "map" && <div className={cn("absolute right-3 flex flex-col overflow-hidden rounded-lg border border-white/20 bg-brand-bar/85 text-white backdrop-blur", mapBottom)}>
          {mapEngine === "azure" && <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" aria-label="Choose the base map" title="Base map" className="grid size-9 place-items-center border-b border-white/15 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white"><Layers className="size-4" aria-hidden="true" /></button></DropdownMenuTrigger>
            <DropdownMenuContent side="left" align="end">
              <DropdownMenuLabel>Base map</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Azure Maps</DropdownMenuLabel>
              {BASE_MAPS.map((m) => <DropdownMenuCheckboxItem key={m.id} checked={baseMap === m.id} onCheckedChange={() => pickBaseMap(m.id)}>{m.label}</DropdownMenuCheckboxItem>)}
              {esri?.enabled && <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Esri ArcGIS</DropdownMenuLabel>
                {esri.styles.map((s) => <DropdownMenuCheckboxItem key={s.id} checked={baseMap === s.id} onCheckedChange={() => pickBaseMap(s.id, s.tiles)}>{s.label}</DropdownMenuCheckboxItem>)}
              </>}
              {esri && !esri.enabled && service?.owner && <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Esri ArcGIS</DropdownMenuLabel>
                <DropdownMenuItem disabled>{esri.reason ?? "Not available"}</DropdownMenuItem>
              </>}
            </DropdownMenuContent>
          </DropdownMenu>}
          <button type="button" aria-label="Draw a cross-section" title="Draw a cross-section" className={cn("grid size-9 place-items-center hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white", secPick && "bg-[#C2410C]")} onClick={() => (secPick ? setSecPick(false) : startSection())}><Spline className="size-4" aria-hidden="true" /></button>
          <button type="button" aria-label="Draw an area" aria-pressed={areaPick} title="Draw an area and see what we know inside it" className={cn("grid size-9 place-items-center border-t border-white/15 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white", areaPick && "bg-cyan-800")} onClick={() => (areaPick ? clearArea() : startArea())}><Pentagon className="size-4" aria-hidden="true" /></button>
          <button type="button" aria-label="Zoom in" className="grid size-9 place-items-center border-t border-white/15 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white" onClick={() => control.current?.zoomBy(1)}><Plus className="size-4" aria-hidden="true" /></button>
          <button type="button" aria-label="Zoom out" className="grid size-9 place-items-center border-t border-white/15 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white" onClick={() => control.current?.zoomBy(-1)}><Minus className="size-4" aria-hidden="true" /></button>
          <button type="button" aria-label="Reset view" className="grid size-9 place-items-center border-t border-white/15 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-white" onClick={() => { setHighlight(new Set()); setHere(null); setActiveDoc(null); clearArea(); control.current?.reset(); }}><RotateCcw className="size-4" aria-hidden="true" /></button>
        </div>}
        {view === "map" && mapEngine === "azure" && esriStyle && <EsriCredit credits={esriStyle.credits} overlay={pcLayer} />}
      </section>
      {copilot}
      </div>
      <IngestDialog open={ingestOpen} onOpenChange={setIngestOpen} g={g} showBuild={showBuild} done={added} onDone={onIngested}
        onAsk={(q) => { setIngestOpen(false); doAsk(q); }} onShowPlace={(lon, lat, label) => { setIngestOpen(false); setView("map"); flyTo(lon, lat, 8.4, label, 4); }}
        onOpenEntity={(id) => { setIngestOpen(false); run([{ type: "entity", id }]); }} onPropose={onPropose} uploadsOpen={service?.uploads} />
      <RolePicker open={roleOpen} onPick={pickRole} onTrack={startTrack} onClose={() => { setRoleOpen(false); setRolePicked(true); }} />
      <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
        <DialogContent className="max-w-md">
          <DialogTitle>About GeoBasin Explorer AI</DialogTitle>
          <DialogDescription>{CLOUD
            ? `A map-first geoscience prototype on public Australian basin data, running in its own Azure tenant behind Microsoft Entra sign-in. Answers come from Azure AI services, the map from Azure Maps${esri?.enabled ? ` with Esri ArcGIS base maps as an option${planetary?.enabled ? ", over which Microsoft Planetary Computer Pro can lay Copernicus imagery and elevation for the Cooper Basin" : ""}` : ""}, and sections and spatial checks from a GDAL/PROJ service.`
            : "A map-first geoscience prototype on public Australian basin data. One offline file: no login, no network calls, no telemetry."}</DialogDescription>
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-muted-foreground">Original prototype built by</dt><dd>Jorge Peña Alarcón, Microsoft</dd></div>
            <div><dt className="text-xs text-muted-foreground">Architected and enhanced into an Azure platform by</dt><dd>Kim Vaddi, Microsoft</dd></div>
            <div><dt className="text-xs text-muted-foreground">Built with</dt><dd>The Microsoft account and architecture team</dd></div>
            <div><dt className="text-xs text-muted-foreground">Data</dt><dd className="text-xs">Geoscience Australia (CC BY 4.0), PEPS SA (CC BY 4.0), Geological Survey of Queensland open-file reports, World Stress Map 2025, Natural Earth. Details in the Data sheet.</dd></div>
            <div><dt className="text-xs text-muted-foreground">What it is</dt><dd className="text-xs">{CLOUD
              ? "A working prototype. Every answer cites its source or says Not found, and an independent model checks each statement before you see it."
              : "A working prototype. Answers come from the data in this file and are computed in your browser. Nothing calls a live AI service. The production design runs on your own cloud tenant."}</dd></div>
          </dl>
        </DialogContent>
      </Dialog>
      {CLOUD && <Dialog open={liveSourceOpen} onOpenChange={setLiveSourceOpen}>
        <DialogContent className="max-h-[94dvh] max-w-4xl overflow-y-auto">
          <DialogTitle>Marabooka 1 live publication</DialogTitle>
          <DialogDescription>Open the current steward-approved PDF through the authenticated API. Packaged pages are never substituted here.</DialogDescription>
          {(() => { const source = publication.sources.find((s) => s.sourceId === "peps-sa-marabooka-1"); return publication.enabled && source && publication.manifestVersion ? <LivePublishedSource key={`${source.sha256}:${source.extractionVersion}`} source={source} manifestVersion={publication.manifestVersion} /> : <p role="status">This source is not currently published.</p>; })()}
        </DialogContent>
      </Dialog>}
      <LineageSheet g={g} id={lineageId} open={!!lineageId} onOpenChange={(o) => { if (!o) setLineageId(null); }} showBuild={showBuild} />
      <Dialog open={!!tagAt} onOpenChange={(o) => { if (!o) setTagAt(null); }}>
        <DialogContent className="max-w-md">
          <DialogTitle>Tag this spot</DialogTitle>
          <DialogDescription>{tagAt ? `${Math.abs(tagAt[1]).toFixed(4)}°S ${tagAt[0].toFixed(4)}°E (GDA94).` : ""} Your tag is saved with Notes in this browser and shows on the map.</DialogDescription>
          <div className="space-y-2">
            <div className="space-y-1"><Label htmlFor="tag-title">Title</Label><Input id="tag-title" value={tagTitle} onChange={(e) => setTagTitle(e.target.value)} placeholder="e.g. Possible lead near the trough margin" /></div>
            <div className="space-y-1"><Label htmlFor="tag-note">Note</Label><Textarea id="tag-note" rows={3} value={tagNote} onChange={(e) => setTagNote(e.target.value)} placeholder="What you saw and why it matters" /></div>
            <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setTagAt(null)}><X aria-hidden="true" /> Cancel</Button><Button type="button" onClick={saveTag}>Save tag</Button></div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
/* Esri requires "Powered by Esri" and the data credits of every layer on the map while its tiles show
   (developers.arcgis.com/documentation/esri-and-data-attribution). The line sits above the Azure Maps credits, clear of
   the map controls and the section sheet; the credits are cut to one line and open in full on click. A Planetary
   Computer overlay adds its licensor's notice on a second line, which opens the same way (DATA_SOURCES.md). */
function EsriCredit({ credits, overlay }: { credits: string; overlay?: PlanetaryLayer | null }) {
  const [open, setOpen] = useState(false);
  const line = cn("min-w-0 text-left hover:text-white focus-visible:outline-1 focus-visible:outline-white", open ? "whitespace-normal" : "truncate");
  return (
    <div className="absolute bottom-[22px] right-14 z-20 flex max-w-[min(70%,42rem)] flex-col rounded bg-black/60 px-1.5 text-[10px] leading-[13px] text-white/90" data-gbx-esri-credit>
      <div className="flex items-start gap-1">
        <span className="shrink-0">Powered by <a href="https://www.esri.com" target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-white">Esri</a></span>
        <button type="button" aria-expanded={open} title={open ? "Show less" : credits} onClick={() => setOpen((o) => !o)} className={line}>
          <span className="sr-only">Esri map data credits: </span>{credits}
        </button>
      </div>
      {overlay && <div className="flex items-start gap-1" data-gbx-planetary-credit>
        <span className="shrink-0">Overlay:</span>
        <button type="button" aria-expanded={open} title={open ? "Show less" : overlay.credits} onClick={() => setOpen((o) => !o)} className={line}>
          <span className="sr-only">{overlay.label} credits: </span>{overlay.credits}
        </button>
      </div>}
    </div>
  );
}
export default HomePage;
