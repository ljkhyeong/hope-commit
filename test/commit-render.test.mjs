import assert from "node:assert/strict";
import test from "node:test";

import { digestJson } from "../plugins/hope-commit/skills/commit-diff/scripts/hash.mjs";
import { renderReview } from "../plugins/hope-commit/skills/commit-diff/scripts/render.mjs";
import { validateAnalysis } from "../plugins/hope-commit/skills/commit-diff/scripts/validate.mjs";
import {
  makeAnalysis,
  makeSnapshot,
} from "../test-support/diff-fixture.mjs";

const runId = "6".repeat(32);

function makeCommitSnapshot() {
  const { digest: _digest, ...base } = makeSnapshot();
  const commitId = base.snapshot.head;
  const parentId = base.snapshot.base;
  const value = {
    ...base,
    commit: {
      author: "octocat",
      authoredAt: "2026-07-23T00:00:00.000Z",
      body: "Return the final error after all retries fail.",
      id: commitId,
      parent: parentId,
      parentCount: 1,
      parentNumber: 1,
      subject: base.pullRequest.title,
      url: `https://github.com/example/hope/commit/${commitId}`,
    },
    pullRequest: {
      ...base.pullRequest,
      number: 0,
      state: "immutable",
      url: `https://github.com/example/hope/commit/${commitId}`,
    },
    repository: {
      ...base.repository,
      base: { name: "hope", owner: "example" },
      head: { name: "hope", owner: "example" },
      webUrl: "https://github.com/example/hope",
    },
    snapshot: {
      ...base.snapshot,
      mergeBase: parentId,
    },
  };
  return Object.freeze({ ...value, digest: digestJson(value) });
}

test("commit HTML includes its identity and complete bundled font licenses", async () => {
  const snapshot = makeCommitSnapshot();
  const review = validateAnalysis(makeAnalysis(snapshot, runId), snapshot, { runId });
  const artifact = await renderReview(review);
  const html = artifact.bytes.toString("utf8");

  assert.match(html, /<span>HOPE<\/span><span class="brand-product">· COMMIT<\/span>/u);
  assert.match(html, /Bundled font licenses/u);
  assert.match(html, /SIL OPEN FONT LICENSE\s+Version 1\.1/u);
  assert.match(html, /Copyright \(c\) 2015, NAVER Corporation/u);
  assert.match(html, /Gmarket Sans/u);
});
