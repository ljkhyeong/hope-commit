import { expect, test } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { digestJson } from "../plugins/hope/review-core/hash.mjs";
import { renderReview } from "../plugins/hope/skills/commit/scripts/render.mjs";
import { validateAnalysis } from "../plugins/hope/skills/commit/scripts/validate.mjs";
import {
  makeAnalysis,
  makeSnapshot,
} from "../test-support/diff-fixture.mjs";

const runId = "8".repeat(32);
let artifactDirectory;
let artifactUrl;

function makeCommitSnapshot() {
  const { digest: _digest, pullRequest, ...base } = makeSnapshot({ locale: "ko-KR" });
  const commitId = base.snapshot.head;
  const parentId = base.snapshot.base;
  const value = {
    ...base,
    commit: {
      author: "octocat",
      authoredAt: "2026-08-30T00:00:00.000Z",
      body: "마지막 재시도 오류를 호출자에게 전달합니다.",
      id: commitId,
      parent: parentId,
      parentCount: 1,
      parentNumber: 1,
      subject: pullRequest.title,
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
    sources: base.sources.map((source) => ({
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

test.beforeAll(async () => {
  artifactDirectory = await mkdtemp(join(tmpdir(), "hope-commit-browser-review-"));
  const snapshot = makeCommitSnapshot();
  const review = validateAnalysis(makeAnalysis(snapshot, runId), snapshot, { runId });
  const artifact = await renderReview(review);
  const artifactPath = join(artifactDirectory, "commit-review.html");
  await writeFile(artifactPath, artifact.bytes);
  artifactUrl = pathToFileURL(artifactPath).href;
});

test.afterAll(async () => {
  await rm(artifactDirectory, { force: true, recursive: true });
});

test("Commit Diff 모바일 화면에서 근거 미리보기를 열고 닫는다", async ({ page }) => {
  await page.setViewportSize({ height: 812, width: 375 });
  await page.goto(artifactUrl);

  await expect(page.locator(".brand-product")).toHaveText("· COMMIT");
  await expect(page.locator("header .commit-link")).toBeVisible();
  const marker = page.locator(".evidence-marker").first();
  await marker.click();

  const popover = page.locator("#evidence-popover");
  await expect(popover).toBeVisible();
  await expect(popover.locator(".code-evidence, .source-text")).toBeVisible();
  const box = await popover.boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);

  const close = popover.locator(".evidence-popover-close");
  const closeBox = await close.boundingBox();
  expect(closeBox.height).toBeGreaterThanOrEqual(44);
  expect(closeBox.width).toBeGreaterThanOrEqual(44);
  await close.click();
  await expect(popover).not.toBeVisible();
  await expect(marker).toBeFocused();
});
