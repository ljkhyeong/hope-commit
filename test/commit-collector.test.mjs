import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  collectLocalGitCommit,
  revalidateLocalGitSnapshot,
} from "../plugins/hope-commit/skills/commit/scripts/git.mjs";
import {
  parseCommitTargetArgument,
  resolveLocalCommitTarget,
} from "../plugins/hope-commit/skills/commit/scripts/target.mjs";

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
  }).trim();
}

function gitWithInput(repository, arguments_, input) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
    input,
  }).trim();
}

async function repositoryFixture() {
  const repository = await mkdtemp(join(tmpdir(), "hope-commit-test-"));
  git(repository, "init");
  git(repository, "config", "user.name", "Hope Commit Test");
  git(repository, "config", "user.email", "hope-commit@example.invalid");
  await writeFile(join(repository, "example.txt"), "before\n", "utf8");
  git(repository, "add", "example.txt");
  git(repository, "commit", "-m", "Add example");
  const root = git(repository, "rev-parse", "HEAD");
  await writeFile(join(repository, "example.txt"), "after\n", "utf8");
  git(repository, "add", "example.txt");
  git(repository, "commit", "-m", "Change example");
  const head = git(repository, "rev-parse", "HEAD");
  return { head, repository, root };
}

test("resolves a short commit ID and captures immutable commit blobs", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));

  await writeFile(join(fixture.repository, "example.txt"), "dirty worktree\n", "utf8");
  const target = await resolveLocalCommitTarget({
    commit: fixture.head.slice(0, 8),
    repositoryPath: fixture.repository,
  });
  const snapshot = await collectLocalGitCommit(target, {
    locale: "en-US",
    localeSource: "explicit",
    theme: "system",
    themeSource: "default",
  });

  assert.equal(snapshot.commit.id, fixture.head);
  assert.equal(snapshot.commit.parent, fixture.root);
  assert.equal(snapshot.files.length, 1);
  assert.equal(snapshot.files[0].path, "example.txt");
  const patch = snapshot.sources.find((source) => source.kind === "patch")?.text;
  assert.match(patch, /\+after/u);
  assert.doesNotMatch(patch, /dirty worktree/u);
  assert.equal((await revalidateLocalGitSnapshot(snapshot)).matches, true);
});

test("compares a root commit with the empty tree", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));

  const snapshot = await collectLocalGitCommit({
    commit: fixture.root,
    parentNumber: 1,
    repositoryPath: fixture.repository,
  }, {
    locale: "en-US",
    localeSource: "explicit",
    theme: "system",
    themeSource: "default",
  });

  assert.equal(snapshot.commit.parentCount, 0);
  assert.equal(snapshot.files[0].providerStatus, "added");
  assert.match(snapshot.sources.find((source) => source.kind === "patch")?.text, /\+before/u);
});

test("selects an explicit merge parent", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const mainBranch = git(fixture.repository, "branch", "--show-current");

  git(fixture.repository, "switch", "--quiet", "-c", "side", fixture.head);
  await writeFile(join(fixture.repository, "side.txt"), "side\n", "utf8");
  git(fixture.repository, "add", "side.txt");
  git(fixture.repository, "commit", "-m", "Add side");
  const side = git(fixture.repository, "rev-parse", "HEAD");

  git(fixture.repository, "switch", "--quiet", mainBranch);
  await writeFile(join(fixture.repository, "main.txt"), "main\n", "utf8");
  git(fixture.repository, "add", "main.txt");
  git(fixture.repository, "commit", "-m", "Add main");
  const main = git(fixture.repository, "rev-parse", "HEAD");
  git(fixture.repository, "merge", "--quiet", "--no-ff", "side", "-m", "Merge side");
  const merge = git(fixture.repository, "rev-parse", "HEAD");

  const firstParent = await collectLocalGitCommit({
    commit: merge,
    parentNumber: 1,
    repositoryPath: fixture.repository,
  }, {
    locale: "en-US",
    localeSource: "explicit",
    theme: "system",
    themeSource: "default",
  });
  const secondParent = await collectLocalGitCommit({
    commit: merge,
    parentNumber: 2,
    repositoryPath: fixture.repository,
  }, {
    locale: "en-US",
    localeSource: "explicit",
    theme: "system",
    themeSource: "default",
  });

  assert.equal(firstParent.commit.parent, main);
  assert.equal(secondParent.commit.parent, side);
  assert.deepEqual(firstParent.files.map((file) => file.path), ["side.txt"]);
  assert.deepEqual(secondParent.files.map((file) => file.path), ["main.txt"]);
});

test("preserves rename identity and line counts", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));

  git(fixture.repository, "mv", "example.txt", "renamed.txt");
  git(fixture.repository, "commit", "-m", "Rename example");
  const renamedCommit = git(fixture.repository, "rev-parse", "HEAD");
  const snapshot = await collectLocalGitCommit({
    commit: renamedCommit,
    repositoryPath: fixture.repository,
  }, {
    locale: "en-US",
    localeSource: "explicit",
    theme: "system",
    themeSource: "default",
  });

  assert.equal(snapshot.files[0].providerStatus, "renamed");
  assert.equal(snapshot.files[0].previousPath, "example.txt");
  assert.equal(snapshot.files[0].path, "renamed.txt");
  assert.equal(snapshot.files[0].additions, 0);
  assert.equal(snapshot.files[0].deletions, 0);
});

test("treats changed file names as literal Git paths", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));

  await writeFile(join(fixture.repository, "[a].txt"), "literal before\n", "utf8");
  await writeFile(join(fixture.repository, "a.txt"), "pattern before\n", "utf8");
  git(fixture.repository, "add", "--", "[a].txt", "a.txt");
  git(fixture.repository, "commit", "-m", "Add pathspec fixtures");
  await writeFile(join(fixture.repository, "[a].txt"), "literal after\nsecond line\n", "utf8");
  await writeFile(join(fixture.repository, "a.txt"), "pattern after\nsecond line\nthird line\n", "utf8");
  git(fixture.repository, "add", "--", "[a].txt", "a.txt");
  git(fixture.repository, "commit", "-m", "Change pathspec fixtures");

  const snapshot = await collectLocalGitCommit({
    commit: git(fixture.repository, "rev-parse", "HEAD"),
    repositoryPath: fixture.repository,
  }, {
    locale: "en-US",
    localeSource: "explicit",
    theme: "system",
    themeSource: "default",
  });
  const literalFile = snapshot.files.find((file) => file.path === "[a].txt");
  const patch = snapshot.sources.find((source) => source.fileId === literalFile.id)?.text;

  assert.equal(literalFile.additions, 2);
  assert.equal(literalFile.deletions, 1);
  assert.match(patch, /diff --git a\/\[a\]\.txt b\/\[a\]\.txt/u);
  assert.doesNotMatch(patch, /diff --git a\/a\.txt b\/a\.txt/u);
});

test("collects an uncolored patch without running text conversion", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const marker = join(fixture.repository, "textconv-ran");
  const textconv = join(fixture.repository, "textconv.sh");

  await writeFile(join(fixture.repository, ".gitattributes"), "example.txt diff=marker\n", "utf8");
  git(fixture.repository, "add", ".gitattributes");
  git(fixture.repository, "commit", "-m", "Configure text conversion");
  await writeFile(textconv, `#!/bin/sh\nprintf invoked > "${marker}"\ncat "$1"\n`, "utf8");
  await chmod(textconv, 0o755);
  git(fixture.repository, "config", "diff.marker.textconv", textconv);
  git(fixture.repository, "config", "color.ui", "always");
  await writeFile(join(fixture.repository, "example.txt"), "plain patch\n", "utf8");
  git(fixture.repository, "add", "example.txt");
  git(fixture.repository, "commit", "-m", "Change attributed file");

  const snapshot = await collectLocalGitCommit({
    commit: git(fixture.repository, "rev-parse", "HEAD"),
    repositoryPath: fixture.repository,
  }, {
    locale: "en-US",
    localeSource: "explicit",
    theme: "system",
    themeSource: "default",
  });
  const patch = snapshot.sources.find((source) => source.kind === "patch")?.text;

  await assert.rejects(access(marker), (error) => error?.code === "ENOENT");
  assert.match(patch, /\+plain patch/u);
  assert.doesNotMatch(patch, /\u001b|\uFFFD/u);
});

test("rejects non-UTF-8 Git paths before decoding them", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const blob = gitWithInput(
    fixture.repository,
    ["hash-object", "-w", "--stdin"],
    Buffer.from("invalid path fixture\n"),
  );
  const treeInput = Buffer.concat([
    Buffer.from(`100644 blob ${blob}\tinvalid-`),
    Buffer.from([0xff]),
    Buffer.from(".txt\0"),
  ]);
  const tree = gitWithInput(fixture.repository, ["mktree", "-z"], treeInput);
  const commit = gitWithInput(
    fixture.repository,
    ["commit-tree", tree, "-p", fixture.head],
    "Add invalid path\n",
  );

  await assert.rejects(
    collectLocalGitCommit({
      commit,
      repositoryPath: fixture.repository,
    }, {
      locale: "en-US",
      localeSource: "explicit",
      theme: "system",
      themeSource: "default",
    }),
    /does not support non-UTF-8 Git paths/u,
  );
});

test("rejects non-hexadecimal target strings", () => {
  assert.throws(
    () => parseCommitTargetArgument("HEAD; touch unexpected"),
    /hexadecimal commit ID/u,
  );
});
