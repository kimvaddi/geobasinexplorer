// Application Insights through OpenTelemetry, when a connection string is configured. Imported first by server.ts and worker.ts.
// Request bodies, prompts and answers are not recorded (no unredacted content in logs by default).
// Esri map tiles are not traced: a screen of map is dozens of requests and they would crowd out everything else
// (Learn: azure-monitor/app/opentelemetry-filter, "Filter OpenTelemetry using instrumentation libraries").
import { useAzureMonitor } from "@azure/monitor-opentelemetry";
import type { HttpInstrumentationConfig } from "@opentelemetry/instrumentation-http";

const http: HttpInstrumentationConfig = { enabled: true, ignoreIncomingRequestHook: (req) => (req.url ?? "").startsWith("/api/basemap/esri/") };
const cs = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING;
if (cs) useAzureMonitor({ azureMonitorExporterOptions: { connectionString: cs }, samplingRatio: 0.5, enableLiveMetrics: false, instrumentationOptions: { http } });
