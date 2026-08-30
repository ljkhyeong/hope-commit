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
let localArtifactUrl;

function makeCommitSnapshot({ remote = true } = {}) {
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
      url: remote ? `https://github.com/example/hope/commit/${commitId}` : undefined,
    },
    repository: {
      ...base.repository,
      base: { name: "hope", owner: "example" },
      head: { name: "hope", owner: "example" },
      provider: remote ? "github" : "local-git",
      webUrl: remote ? "https://github.com/example/hope" : undefined,
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
  for (const remote of [true, false]) {
    const snapshot = makeCommitSnapshot({ remote });
    const review = validateAnalysis(makeAnalysis(snapshot, runId), snapshot, { runId });
    const artifact = await renderReview(review);
    const artifactPath = join(artifactDirectory, remote ? "commit-review.html" : "local-review.html");
    await writeFile(artifactPath, artifact.bytes);
    if (remote) artifactUrl = pathToFileURL(artifactPath).href;
    else localArtifactUrl = pathToFileURL(artifactPath).href;
  }
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

test("원격 링크가 없는 Commit Diff도 커밋 ID와 근거를 표시한다", async ({ page }) => {
  await page.goto(localArtifactUrl);

  await expect(page.locator("header .commit-link")).toHaveCount(0);
  await expect(page.locator("h1")).toBeVisible();
  await expect(page.locator("#evidence-and-scope")).toContainText("b".repeat(40));
  await page.locator(".evidence-marker").first().click();
  await expect(page.locator("#evidence-popover")).toBeVisible();
});

test("Commit Diff 테마와 근거 미리보기를 키보드로 조작한다", async ({ page }) => {
  await page.goto(artifactUrl);
  const theme = page.locator("#theme-toggle");

  await theme.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(theme).toHaveAttribute("aria-label", "라이트 모드로 전환");
  await page.keyboard.press("Space");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(theme).toHaveAttribute("aria-label", "다크 모드로 전환");

  const marker = page.locator(".evidence-marker").first();
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#evidence-popover")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#evidence-popover")).not.toBeVisible();
  await expect(marker).toBeFocused();
});

test("Commit Diff는 JavaScript 없이도 본문과 근거를 읽을 수 있다", async ({ browser }) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { height: 812, width: 375 },
  });
  const page = await context.newPage();
  const externalRequests = [];
  page.on("request", (request) => {
    if (/^https?:/u.test(request.url())) externalRequests.push(request.url());
  });
  try {
    await page.goto(localArtifactUrl);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("#synopsis")).toBeVisible();
    const judge = page.locator("#judge");
    await judge.locator(":scope > summary").click();
    await expect(judge.locator(".review-items-full")).toBeVisible();
    const evidence = page.locator("#evidence-and-scope");
    await expect(evidence).toHaveAttribute("open", "");
    const sources = evidence.locator("details.evidence-group").filter({
      has: page.getByRole("heading", { exact: true, name: "그 밖의 수집 출처" }),
    });
    await sources.locator(":scope > summary").click();
    await expect(sources.locator("table")).toBeVisible();
    await expect(page.locator(
      '.code-evidence code[aria-label*="throw new Error()"]',
    ).first()).toContainText("throw new Error()");
    expect(externalRequests).toEqual([]);
  } finally {
    await context.close();
  }
});
