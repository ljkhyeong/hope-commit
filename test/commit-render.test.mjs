import assert from "node:assert/strict";
import test from "node:test";

import { digestJson } from "../plugins/hope/review-core/hash.mjs";
import { renderCodeEvidence } from "../plugins/hope/skills/commit/scripts/code-evidence.mjs";
import { renderReview } from "../plugins/hope/skills/commit/scripts/render.mjs";
import { validateAnalysis } from "../plugins/hope/skills/commit/scripts/validate.mjs";
import {
  makeAnalysis,
  makeSnapshot,
} from "../test-support/diff-fixture.mjs";

const runId = "6".repeat(32);

test("패치 본문이 파일 헤더처럼 보여도 변경 종류와 줄 번호를 유지한다", () => {
  const source = {
    text: [
      "diff --git a/example.txt b/example.txt",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -10,3 +20,3 @@",
      "---counter;",
      "-old();",
      "+++counter;",
      "+next();",
      " unchanged();",
      "@@ -30 +40 @@",
      "--- old header-like text",
      "+++ new header-like text",
    ].join("\n"),
  };
  const rendered = renderCodeEvidence({
    excerpt: source.text,
    sourceKind: "patch",
  });
  const lines = rendered.split("\n");
  assert.match(lines[1], /code-line-meta/u);
  assert.match(lines[2], /code-line-meta/u);
  assert.match(lines[4], /code-line-removed.*data-old-line="10" data-new-line=""/u);
  assert.match(lines[5], /data-old-line="11" data-new-line=""/u);
  assert.match(lines[6], /code-line-added.*data-old-line="" data-new-line="20"/u);
  assert.match(lines[7], /data-old-line="" data-new-line="21"/u);
  assert.match(lines[8], /data-old-line="12" data-new-line="22"/u);
  assert.match(lines[10], /code-line-removed.*data-old-line="30"/u);
  assert.match(lines[11], /code-line-added.*data-new-line="40"/u);
});

function makeCommitSnapshot() {
  const { digest: _digest, ...base } = makeSnapshot();
  const commitId = base.snapshot.head;
  const parentId = base.snapshot.base;
  const subject = base.pullRequest.title;
  const { pullRequest: _pullRequest, ...commitBase } = base;
  const value = {
    ...commitBase,
    commit: {
      author: "octocat",
      authoredAt: "2026-07-23T00:00:00.000Z",
      body: "Return the final error after all retries fail.",
      id: commitId,
      parent: parentId,
      parentCount: 1,
      parentNumber: 1,
      subject,
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
    sources: base.sources.map((source) => Object.freeze({
      ...source,
      kind: source.kind === "pull-request-title"
        ? "commit-title"
        : source.kind === "pull-request-description"
          ? "commit-body"
          : source.kind,
      revision: source.kind.startsWith("pull-request-")
        ? commitId
        : source.revision,
    })),
  };
  return Object.freeze({ ...value, digest: digestJson(value) });
}

test("commit HTML includes its identity and complete bundled font licenses", async () => {
  const snapshot = makeCommitSnapshot();
  const review = validateAnalysis(makeAnalysis(snapshot, runId), snapshot, { runId });
  const artifact = await renderReview(review);
  const html = artifact.bytes.toString("utf8");

  assert.match(html, /<span>HOPE<\/span><span class="brand-product">· COMMIT<\/span>/u);
  assert.match(html, /class="evidence-marker"/u);
  assert.match(html, /id="evidence-popover" popover="auto"/u);
  assert.match(html, /id="evidence-references"/u);
  assert.match(html, /Bundled font licenses/u);
  assert.match(html, /SIL OPEN FONT LICENSE\s+Version 1\.1/u);
  assert.match(html, /Copyright \(c\) 2015, NAVER Corporation/u);
  assert.match(html, /Gmarket Sans/u);
});

test("HTML의 부분 인용도 전체 패치를 기준으로 코드 줄 번호를 표시한다", async () => {
  const snapshot = makeCommitSnapshot();
  const review = validateAnalysis(makeAnalysis(snapshot, runId), snapshot, { runId });
  const html = (await renderReview(review)).bytes.toString("utf8");
  const excerpt = html.match(/<code aria-label="-throw new Error\(\)[^"]*">([\s\S]*?)<\/code>/u)?.[1];

  assert.ok(excerpt);
  assert.match(excerpt, /code-line-removed" data-old-line="1" data-new-line=""/u);
  assert.match(excerpt, /code-line-added" data-old-line="" data-new-line="2"/u);
});

test("Commit Diff rejects exact duplicate sibling claims", () => {
  const snapshot = makeCommitSnapshot();
  const duplicateDetail = makeAnalysis(snapshot, runId);
  duplicateDetail.coreChange.details.push(
    structuredClone(duplicateDetail.coreChange.details[0]),
  );

  assert.throws(
    () => validateAnalysis(duplicateDetail, snapshot, { runId }),
    /coreChange\.details\[1\] duplicates coreChange\.details\[0\]/u,
  );
});

test("Commit Diff evidence markers follow document number order", async () => {
  const snapshot = makeCommitSnapshot();
  const review = validateAnalysis(makeAnalysis(snapshot, runId), snapshot, { runId });
  const html = (await renderReview(review)).bytes.toString("utf8");
  const synopsis = html.match(
    /<section class="synopsis" id="synopsis"[\s\S]*?<\/section>/u,
  )?.[0] ?? "";
  const impactStart = synopsis.indexOf('class="synopsis-row synopsis-impact"');
  const reviewStart = synopsis.indexOf('class="synopsis-row synopsis-review"');
  const impact = synopsis.slice(impactStart, reviewStart);

  assert.deepEqual(
    [...impact.matchAll(/class="evidence-marker"[^>]*>\[([0-9]+)\]<\/a>/gu)]
      .map((match) => Number(match[1])),
    [1, 2],
  );
});
