import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";

import { LIMITS } from "../plugins/hope/skills/commit/scripts/constants.mjs";
import {
  collectLocalGitContext,
} from "../plugins/hope/skills/commit/scripts/git-context.mjs";
import {
  registerTestTemporaryDirectoryCleanup,
} from "../test-support/temporary-directory.mjs";

const createTestTemporaryDirectory = registerTestTemporaryDirectoryCleanup(after);

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
  }).trim();
}

async function repositoryFixture() {
  const repository = await createTestTemporaryDirectory("hope-commit-context-");
  execFileSync("git", ["init", "--quiet", repository]);
  git(repository, "config", "user.name", "Hope Commit 테스트");
  git(repository, "config", "user.email", "hope-commit@example.invalid");
  await mkdir(join(repository, "src"), { recursive: true });
  const sourcePath = join(repository, "src", "shared.mjs");

  await writeFile(sourcePath, "export const state = 'before';\n", "utf8");
  git(repository, "add", "src/shared.mjs");
  git(repository, "commit", "--quiet", "-m", "이전 맥락 추가");
  const mergeBase = git(repository, "rev-parse", "HEAD");

  await writeFile(sourcePath, "export const state = 'after';\n", "utf8");
  git(repository, "add", "src/shared.mjs");
  git(repository, "commit", "--quiet", "-m", "현재 맥락 변경");
  const head = git(repository, "rev-parse", "HEAD");

  await writeFile(sourcePath, "export const state = 'dirty';\n", "utf8");
  return { head, mergeBase, repository };
}

function snapshot({ head, mergeBase, repository }) {
  return {
    repository: { path: repository },
    snapshot: { head, mergeBase },
  };
}

test("Commit Diff 맥락이 작업 트리 대신 지정한 Git 객체를 읽는다", async () => {
  const fixture = await repositoryFixture();
  const result = await collectLocalGitContext(
    snapshot(fixture),
    [
      { path: "src/shared.mjs", revision: "head" },
      { path: "src/shared.mjs", revision: "merge-base" },
    ],
  );

  assert.deepEqual(result.map(({ revision, text }) => ({ revision, text })), [
    { revision: fixture.head, text: "export const state = 'after';\n" },
    { revision: fixture.mergeBase, text: "export const state = 'before';\n" },
  ]);
});

test("Commit Diff 맥락이 위험 경로와 비공개 경로를 수집 전에 막는다", async () => {
  const immutable = "a".repeat(40);
  const value = snapshot({
    head: immutable,
    mergeBase: immutable,
    repository: "/repo",
  });
  let executed = false;
  const result = await collectLocalGitContext(
    value,
    [{ path: ".git-credentials", revision: "head" }],
    {
      exec: async () => {
        executed = true;
        throw new Error("Git을 호출하면 안 됩니다.");
      },
    },
  );

  assert.equal(executed, false);
  assert.equal(result[0].reasonKind, "private-path");
  await assert.rejects(
    collectLocalGitContext(
      value,
      [{ path: "../secret", revision: "head" }],
    ),
    /repository-relative path/u,
  );
});

test("Commit Diff 맥락이 누적 크기 제한을 명시적인 제한으로 기록한다", async () => {
  const fixture = await repositoryFixture();
  const result = await collectLocalGitContext(
    snapshot(fixture),
    [{ path: "src/shared.mjs", revision: "head" }],
    { existingBytes: LIMITS.contextBodyTotalBytes },
  );

  assert.equal(result[0].kind, "context-unavailable");
  assert.equal(result[0].reasonKind, "context-size-limit");
});
