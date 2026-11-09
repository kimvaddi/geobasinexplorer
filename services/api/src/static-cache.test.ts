// Static files (static-cache.ts): a new release reaches an open browser on its next load, because the page is always
// revalidated, while the content-hashed bundles it names are cached for a year and other files for the plugin's hour.
//   node build.mjs --script src/static-cache.test.ts && node --test dist/scripts/static-cache.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import Fastify from "fastify";
import fstatic from "@fastify/static";
import { cacheHeaders } from "./static-cache";

test("the page is revalidated, hashed bundles are kept a year and other files an hour", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gbx-static-"));
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><script src=/assets/index-BT8wgt61.js></script>");
  fs.writeFileSync(path.join(root, "assets", "index-BT8wgt61.js"), "export {};");
  fs.writeFileSync(path.join(root, "favicon.svg"), "<svg/>");
  const app = Fastify();
  await app.register(fstatic, { root, wildcard: false, index: ["index.html"], maxAge: "1h", setHeaders: cacheHeaders });
  try {
    const cache = async (url: string) => { const r = await app.inject({ url }); assert.equal(r.statusCode, 200, url); return r.headers["cache-control"]; };
    assert.equal(await cache("/"), "no-cache");
    assert.equal(await cache("/index.html"), "no-cache");
    assert.equal(await cache("/assets/index-BT8wgt61.js"), "public, max-age=31536000, immutable");
    assert.equal(await cache("/favicon.svg"), "public, max-age=3600");
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
