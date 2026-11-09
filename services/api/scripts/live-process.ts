// Container job entry point; never imported by the HTTP service.
import "../src/otel";
import { runLiveWorker } from "../src/live/pipeline-worker";
try { await runLiveWorker(); } catch { process.exitCode = 1; }
