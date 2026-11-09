// Local-only suite. Dependencies use strict fakes; no live service requests are made.
// node build.mjs --script scripts/test-serving.ts && node --test dist/scripts/test-serving.mjs
import "../src/live/serving-manifest.test";
import "../src/live/serving-pages.test";
import "../src/live/serving-policy.test";
import "../src/live/serving-evaluation.test";
import "../src/live/agent-definition.test";
import "../src/live/agent-tools.test";
import "../src/live/agent-runtime.test";
import "../src/live/agent-answer.test";
import "../src/live/agent-client.test";
import "../src/live/serving-evidence.test";
import "../src/validate.test";
