// Static checks only. These tests do not build images, deploy resources or claim live ABAC enforcement.
import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { PIPELINE_LIMITS } from "./pipeline-config";
const root = "../..";
const read = (file: string) => fs.readFileSync(`${root}/${file}`, "utf8");
test("default web stage excludes Poppler and only pipeline has the pinned package", () => {
  const docker = read("services/api/Dockerfile"), stages = [...docker.matchAll(/^FROM (\S+) AS (\S+)$/gm)];
  assert.equal(stages.at(-1)?.[2], "web"); assert.equal(stages.at(-1)?.[1], "api");
  const pipelineStart = docker.indexOf("FROM api AS pipeline"), webStart = docker.indexOf("FROM api AS web");
  const api = docker.slice(0, pipelineStart), pipeline = docker.slice(pipelineStart, webStart);
  assert.doesNotMatch(api, /apt-get.*poppler|COPY.*--from=pipeline/);
  assert.match(pipeline, /ARG POPPLER_UTILS_VERSION=22\.12\.0-2\+deb12u3/);
  assert.match(pipeline, /poppler-utils=\$\{POPPLER_UTILS_VERSION\}/);
  assert.match(pipeline, /dpkg-query/); assert.match(api, /FROM node:22-bookworm-slim AS api/);
  const ci = read(".github/workflows/ci.yml").split("  api-image:")[1].split("  scanner:")[0];
  assert.match(ci, /docker build -f services\/api\/Dockerfile -t gbx-api:ci \./); assert.doesNotMatch(ci, /--target/);
});
test("both jobs use the separate pipeline image tag and runtime covers the 420-page envelope", () => {
  const bicep = read("infra/bicep/live.bicep");
  assert.match(bicep, /param pipelineImageTag string/); assert.doesNotMatch(bicep, /apiImageTag|\/gbx-api:/);
  assert.equal(bicep.match(/\/gbx-pipeline:\$\{pipelineImageTag\}/g)?.length, 2);
  const envelope = 420 * PIPELINE_LIMITS.renderPageMs + PIPELINE_LIMITS.analysisMs + 60 * 60_000;
  assert.ok(PIPELINE_LIMITS.jobMs > envelope); assert.ok(PIPELINE_LIMITS.replicaTimeoutSeconds * 1000 > PIPELINE_LIMITS.jobMs);
  assert.ok(PIPELINE_LIMITS.leaseMs > PIPELINE_LIMITS.replicaTimeoutSeconds * 1000);
  assert.ok(PIPELINE_LIMITS.queueVisibilitySeconds * 1000 > PIPELINE_LIMITS.leaseMs);
  assert.match(bicep, new RegExp(`replicaTimeout: ${PIPELINE_LIMITS.replicaTimeoutSeconds}`));
});
test("quarantine assignment constrains only pipeline writes to container-relative sources paths", () => {
  const text = read("infra/bicep/modules/live-storage.bicep"), block = text.split("resource landingAccess ")[1].split("resource artifactAccess ")[0];
  assert.match(block, /scope: quarantine/); assert.match(block, /principalId: pipelinePrincipalId/);
  assert.match(block, /conditionVersion: '2\.0'/);
  assert.match(block, /!\(ActionMatches\{'Microsoft.Storage\/storageAccounts\/blobServices\/containers\/blobs\/write'\}\)/);
  assert.match(block, /OR\s+@Resource\[Microsoft.Storage\/storageAccounts\/blobServices\/containers\/blobs:path\] StringLike 'sources\/\*'/);
  assert.doesNotMatch(block, /StringLike '\/sources|StringLike 'quarantine\/sources|@Request\[/);
});
