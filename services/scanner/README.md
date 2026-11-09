# ClamAV scanner

This service scans files in the platform's quarantine container with ClamAV before anything reads them. It serves the live ingestion lane (documents fetched from public publishers) and can serve uploads alongside Microsoft Defender for Storage. It is deliberately narrow: it scans and hands work on, but it neither parses documents nor owns any application job status. ClamAV is a useful, independent gate, not a replacement for Defender's malware scanning; [docs/SECURITY.md](../../docs/SECURITY.md#malware-scanning) explains how the two fit together.

## How it runs

Two Container Apps jobs share one hash-locked image built from official PyPI and Debian packages ([Dockerfile](Dockerfile), [requirements.lock.txt](requirements.lock.txt)). `gbx-scan`, with its own identity `id-gbx-scan`, is an event-driven job: a keyless `azure-queue` scale rule on `scan-jobs` (one visible message, polled every 30 seconds, at most one execution at a time) starts an execution that receives one message, scans the named blob, persists a verdict and forwards the original message to the queue named in its route. `gbx-sigs`, with its own identity `id-gbx-sigs`, runs every six hours and refreshes the signature databases. Both are defined in [infra/bicep/pipeline.bicep](../../infra/bicep/pipeline.bicep) and [infra/terraform/workloads.tf](../../infra/terraform/workloads.tf).

## Messages and routing

A message is base64-encoded UTF-8 JSON with exactly `jobId`, `blob` and `owner`, and optionally `route`. The route must be one of `GBX_ROUTES` (by default `ingest-jobs,process-jobs`) and defaults to `ingest-jobs`; the blob name must be a short relative path of safe characters. Malformed, duplicated or unexpected fields are rejected and the message is discarded without scanning. For a valid message the scanner clears any old verdict, scans, persists a final verdict, forwards the original message text unchanged after any final verdict, and only then deletes the source message, which gives at-least-once delivery; consumers must therefore claim each job identifier once. A message delivered more than three times is not scanned again: the scanner records an error verdict and forwards it. No message is forwarded if a final verdict cannot be persisted, so a stale clean verdict can never authorise the wrong file.

## Scan bounds and verdicts

Each file is downloaded once, up to 200 MB, hashed with SHA-256 as it streams, and scanned from a private local file with expansion limited to 400 MB, recursion to 16 levels and 10,000 embedded objects, within a 180-second wall-clock limit. Alerts for exceeded limits, encrypted content and broken files or media stay on. A genuine detection is `Malicious`; exceeded limits, encrypted or broken content, warnings, skips and anything ambiguous are `Error`; only a clean, unambiguous result is `No threats found`.

## The verdict contract

The verdict is written as six blob index tags, which consumers must read and check exactly:

| Tag | Value |
|---|---|
| `gbx-clamav-scan-result` | `No threats found`, `Malicious` or `Error` |
| `gbx-clamav-sha256` | Lower-case SHA-256 of the whole scanned file |
| `gbx-clamav-engine` | The ClamAV version, followed by ` outdated` when ClamAV reports an outdated engine |
| `gbx-clamav-signature-version` | `main:<version>/daily:<version>/bytecode:<version>` |
| `gbx-clamav-signature-date` | UTC time of the newest signature database |
| `gbx-clamav-scanned-at` | UTC time of the scan |

A consumer accepts a file only when the result is exactly `No threats found`, every tag is present and valid, the signature date precedes the scan time, both are no more than 72 hours old, and the SHA-256 of the bytes it reads matches the tag; it hashes the same buffer it parses and never downloads again. Absent tags mean pending, never clean, and `Malicious` and `Error` are final rejections. [services/api/src/scan-verdict.ts](../api/src/scan-verdict.ts) implements these checks for the platform.

## Signature updates

The updater restores the full, signed `main.cvd`, `daily.cvd` and `bytecode.cvd` databases and the updater state from the private `signatures` container, runs `freshclam` against the official mirror with scripted updates off and database testing on, and publishes only full, signed databases back to the container; incremental formats are refused and removed. Scanners refuse to scan with signatures older than 72 hours, so a lapse in updates closes the gate rather than weakening it.

## Identities and roles

`id-gbx-scan` may read and tag blobs in the quarantine container, read the signatures container, read and process `scan-jobs`, and send to the queues it routes to. `id-gbx-sigs` may write the signatures container. Neither may read the approved containers or any other data, and only trusted principals may start the jobs or write tags, because a digest binds the bytes but not the writer.

## Building and testing

```bash
docker build --platform linux/amd64 -t gbx-scanner:local services/scanner
docker run --rm --network none --entrypoint python3 \
  -v "$PWD/services/scanner/test_scan.py:/app/test_scan.py:ro" \
  -v "$PWD/services/scanner/test_pipeline.py:/app/test_pipeline.py:ro" \
  gbx-scanner:local -m unittest -q test_scan test_pipeline
```

The tests run inside the image without network access, as the CI workflow does. Microsoft Learn references: [blob index tags](https://learn.microsoft.com/azure/storage/blobs/storage-manage-find-blobs), [allowed tag characters](https://learn.microsoft.com/rest/api/storageservices/set-blob-tags#request-body), [Container Apps jobs](https://learn.microsoft.com/azure/container-apps/jobs) and [ephemeral storage](https://learn.microsoft.com/azure/container-apps/storage-mounts#ephemeral-storage).
