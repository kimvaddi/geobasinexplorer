import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { crc32 } from "./pipeline-zip";
import { PIPELINE_LIMITS, PipelineError } from "./pipeline-config";
import type { SilverPageRecord } from "./contracts";
const exec = promisify(execFile);
const root = ".gbx-runs";
async function workspace<T>(bytes: Buffer, run: (dir: string) => Promise<T>): Promise<T> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(root); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe pipeline work directory.");
  const dir = `${root}/${randomUUID()}`; await fs.mkdir(dir, { mode: 0o700 });
  try { await fs.writeFile(`${dir}/document.pdf`, bytes, { flag: "wx", mode: 0o600 }); return await run(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}
export async function rendererVersion(signal?: AbortSignal, run: typeof exec = exec) {
  const r = await run("pdftoppm", ["-v"], { timeout: 10_000, maxBuffer: 64 * 1024, signal, killSignal: "SIGKILL" });
  const version = /^pdftoppm version ([0-9.]+)$/m.exec(`${r.stdout}\n${r.stderr}`)?.[1];
  if (!version) throw new Error("The renderer version could not be pinned."); return version;
}
export async function pdfPageCount(bytes: Buffer, signal?: AbortSignal, run: typeof exec = exec) {
  return workspace(bytes, async (dir) => {
    const r = await run("pdfinfo", ["document.pdf"], { cwd: dir, timeout: 30_000, maxBuffer: 128 * 1024, signal, killSignal: "SIGKILL" });
    const matches = [...r.stdout.matchAll(/^Pages:\s+(\d+)$/gm)];
    const count = matches.length === 1 ? Number(matches[0][1]) : NaN;
    if (!Number.isSafeInteger(count) || count < 1 || count > PIPELINE_LIMITS.pages || /^Encrypted:\s+yes/m.test(r.stdout)) throw new PipelineError(422, "Encrypted, unreadable or oversized PDF page count.");
    return count;
  });
}
export function requirePng(bytes: Buffer) {
  if (bytes.length < 45 || bytes.length > PIPELINE_LIMITS.imageBytes || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error("Invalid rendered page image.");
  const w = bytes.readUInt32BE(16), h = bytes.readUInt32BE(20);
  if (!w || !h || w > 2200 || h > 2200) throw new Error("Rendered image exceeds pixel bounds.");
  let offset = 8, hasImage = false, ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + length + 12, kind = bytes.subarray(offset + 4, offset + 8).toString();
    if (end > bytes.length || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error("PNG chunk integrity failed.");
    if (offset === 8 && (kind !== "IHDR" || length !== 13)) throw new Error("PNG header is missing.");
    if (kind === "IDAT") hasImage = true;
    if (kind === "IEND") { if (length || end !== bytes.length) throw new Error("PNG end is invalid."); ended = true; break; }
    offset = end;
  }
  if (!hasImage || !ended) throw new Error("PNG is truncated.");
}
export async function renderPages(bytes: Buffer, pages: SilverPageRecord[], consume: (page: SilverPageRecord, png: Buffer) => Promise<void>, signal?: AbortSignal, run: typeof exec = exec) {
  return workspace(bytes, async (dir) => {
    for (const page of pages) {
      signal?.throwIfAborted();
      const factor = Math.min(page.unit === "inch" ? 110 : 1, 2200 / Math.max(page.width, page.height));
      await run("pdftoppm", ["-f", String(page.page), "-l", String(page.page), "-singlefile", "-png", "-r", "110", "-scale-to-x", String(Math.max(1, Math.min(2200, Math.ceil(page.width * factor)))),
        "-scale-to-y", String(Math.max(1, Math.min(2200, Math.ceil(page.height * factor)))), "document.pdf", "page"], { cwd: dir, timeout: PIPELINE_LIMITS.renderPageMs, maxBuffer: 1024 * 1024, signal, killSignal: "SIGKILL" });
      const stat = await fs.stat(`${dir}/page.png`); if (stat.size > PIPELINE_LIMITS.imageBytes) throw new Error("Rendered page exceeds byte bound.");
      const png = await fs.readFile(`${dir}/page.png`); requirePng(png); await consume(page, png); await fs.unlink(`${dir}/page.png`);
    }
  });
}
