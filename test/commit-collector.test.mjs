import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  collectLocalGitCommit,
  readGitBlob,
  revalidateLocalGitSnapshot,
} from "../plugins/hope/skills/commit/scripts/git.mjs";
import {
  parseCommitTargetArgument,
  resolveLocalCommitTarget,
} from "../plugins/hope/skills/commit/scripts/target.mjs";
import { buildInspectionPages } from "../plugins/hope/skills/commit/scripts/run.mjs";

const execFile = promisify(execFileCallback);

function execFileWithInput(command, arguments_, options, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFileCallback(
      command,
      arguments_,
      options,
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          rejectPromise(error);
          return;
        }
        resolvePromise({ stderr, stdout });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

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
  assert.equal(Object.hasOwn(snapshot, "pullRequest"), false);
  assert.deepEqual(
    snapshot.sources.filter((source) => !source.fileId).map((source) => source.kind),
    ["commit-title", "commit-body"],
  );
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
  assert.equal((await revalidateLocalGitSnapshot(snapshot)).matches, true);
});

for (const toDirectory of [true, false]) {
  test(`${toDirectory ? "파일→디렉터리" : "디렉터리→파일"} 변경에서 비공개 하위 파일을 패치에 섞지 않는다`, async (t) => {
    const fixture = await repositoryFixture();
    t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
    const path = join(fixture.repository, "config");
    const marker = "REVIEW_FIXTURE_PRIVATE_VALUE";
    const writeVersion = async (directory) => {
      if (directory) {
        await mkdir(path);
        await writeFile(join(path, ".env"), `PASSWORD=${marker}\n`);
      } else {
        await writeFile(path, "공개 안내문\n");
      }
      git(fixture.repository, "add", "-A");
      git(fixture.repository, "commit", "-m", "경로 변경 재현");
    };
    await writeVersion(!toDirectory);
    await rm(path, { recursive: true });
    await writeVersion(toDirectory);

    const snapshot = await collectLocalGitCommit({
      commit: git(fixture.repository, "rev-parse", "HEAD"),
      repositoryPath: fixture.repository,
    });
    assert.equal(snapshot.files.find((file) => file.path === "config/.env").bodyState, "redacted");
    assert.equal(JSON.stringify(buildInspectionPages(snapshot)).includes(marker), false);
    assert.match(snapshot.sources.find((source) => source.path === "config").text, /공개 안내문/u);
  });

  test(`${toDirectory ? "하위" : "상위"} 디렉터리로 파일을 옮겨도 이름 변경 패치를 보존한다`, async (t) => {
    const fixture = await repositoryFixture();
    t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
    const path = join(fixture.repository, "config[1]");
    const writeVersion = async (directory) => {
      if (directory) {
        await mkdir(path);
        await writeFile(join(path, "public.txt"), "공개 안내문\n");
        await writeFile(join(path, ".env"), "PASSWORD=REVIEW_FIXTURE_PRIVATE_VALUE\n");
      } else {
        await writeFile(path, "공개 안내문\n");
      }
      git(fixture.repository, "add", "-A");
      git(fixture.repository, "commit", "-m", "상하위 경로 이동 재현");
    };
    await writeVersion(!toDirectory);
    await rm(path, { recursive: true });
    await writeVersion(toDirectory);

    const snapshot = await collectLocalGitCommit({
      commit: git(fixture.repository, "rev-parse", "HEAD"),
      repositoryPath: fixture.repository,
    });
    const file = snapshot.files.find((candidate) => candidate.providerStatus === "renamed");
    assert.ok(file);
    const patch = snapshot.sources.find((source) => source.fileId === file.id).text;
    assert.match(patch, /rename from/u);
    assert.match(patch, /rename to/u);
    assert.equal(JSON.stringify(buildInspectionPages(snapshot)).includes("REVIEW_FIXTURE_PRIVATE_VALUE"), false);
  });
}

test("부분 복제에서 누락된 객체를 자동 다운로드하지 않는다", async (t) => {
  const fixture = await repositoryFixture();
  const clone = await mkdtemp(join(tmpdir(), "hope-commit-partial-"));
  t.after(async () => {
    await rm(clone, { force: true, recursive: true });
    await rm(fixture.repository, { force: true, recursive: true });
  });
  git(fixture.repository, "config", "uploadpack.allowFilter", "true");
  git(fixture.repository, "clone", "--quiet", "--filter=blob:none", "--no-checkout",
    pathToFileURL(fixture.repository).href, clone);
  const missing = git(clone, "rev-list", "--objects", "--all", "--missing=print");
  assert.match(missing, /^\?/mu);
  const packDirectory = join(clone, ".git", "objects", "pack");
  const packs = await readdir(packDirectory);

  await assert.rejects(collectLocalGitCommit({
    commit: fixture.head,
    repositoryPath: clone,
  }));
  assert.equal(git(clone, "rev-list", "--objects", "--all", "--missing=print"), missing);
  assert.deepEqual(await readdir(packDirectory), packs);
});

test("서브모듈 무시 설정이 있어도 커밋의 서브모듈 변경을 계상한다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  git(fixture.repository, "update-index", "--add", "--cacheinfo", `160000,${fixture.root},vendor`);
  git(fixture.repository, "commit", "-m", "서브모듈 추가");
  git(fixture.repository, "update-index", "--cacheinfo", `160000,${fixture.head},vendor`);
  git(fixture.repository, "commit", "-m", "서브모듈 버전 변경");
  git(fixture.repository, "config", "diff.ignoreSubmodules", "all");

  const snapshot = await collectLocalGitCommit({
    commit: git(fixture.repository, "rev-parse", "HEAD"),
    repositoryPath: fixture.repository,
  });
  assert.deepEqual(snapshot.files.map(({ path, bodyState }) => ({ path, bodyState })), [
    { path: "vendor", bodyState: "metadata-only" },
  ]);
});

test("Git 환경변수가 다른 저장소를 가리켜도 지정한 저장소를 읽는다", async (t) => {
  const fixture = await repositoryFixture();
  const other = await mkdtemp(join(tmpdir(), "hope-commit-other-"));
  t.after(async () => {
    await rm(other, { force: true, recursive: true });
    await rm(fixture.repository, { force: true, recursive: true });
  });
  git(fixture.repository, "clone", "--quiet", fixture.repository, other);
  const expectedRoot = git(fixture.repository, "rev-parse", "--show-toplevel");
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  try {
    process.env.GIT_DIR = join(other, ".git");
    process.env.GIT_WORK_TREE = other;
    const request = { commit: fixture.head, repositoryPath: fixture.repository };
    const target = await resolveLocalCommitTarget(request);
    const snapshot = await collectLocalGitCommit(request);
    assert.equal(target.repositoryPath, expectedRoot);
    assert.equal(snapshot.repository.path, expectedRoot);
    assert.equal((await readGitBlob(fixture.repository, fixture.head, "example.txt")).text, "after\n");
    assert.equal((await revalidateLocalGitSnapshot(snapshot)).matches, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("실제로 삭제된 커밋 객체는 재검증을 통과하지 못한다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const snapshot = await collectLocalGitCommit({
    commit: fixture.head,
    repositoryPath: fixture.repository,
  });
  await unlink(join(fixture.repository, ".git", "objects", fixture.head.slice(0, 2), fixture.head.slice(2)));
  assert.equal((await revalidateLocalGitSnapshot(snapshot)).matches, false);
});

test("얕은 복제의 누락된 부모를 루트 커밋으로 처리하지 않는다", async (t) => {
  const fixture = await repositoryFixture();
  const shallow = await mkdtemp(join(tmpdir(), "hope-commit-shallow-"));
  t.after(async () => {
    await rm(shallow, { force: true, recursive: true });
    await rm(fixture.repository, { force: true, recursive: true });
  });
  git(fixture.repository, "clone", "--quiet", "--depth=1",
    pathToFileURL(fixture.repository).href, shallow);
  const target = { commit: fixture.head, repositoryPath: shallow };

  await assert.rejects(collectLocalGitCommit(target), /부모 커밋.*로컬/u);

  git(shallow, "fetch", "--quiet", "--deepen=1");
  const snapshot = await collectLocalGitCommit(target);
  assert.equal(snapshot.commit.parent, fixture.root);
  assert.equal(snapshot.files[0].providerStatus, "modified");
});

test("대체 객체가 있어도 원본 커밋과 파일을 읽고 재검증한다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  await writeFile(join(fixture.repository, "example.txt"), "replacement content\n");
  git(fixture.repository, "add", "example.txt");
  git(fixture.repository, "commit", "-m", "대체 커밋");
  const replacement = git(fixture.repository, "rev-parse", "HEAD");
  git(fixture.repository, "replace", fixture.head, replacement);

  const target = await resolveLocalCommitTarget({
    commit: fixture.head,
    repositoryPath: fixture.repository,
  });
  const snapshot = await collectLocalGitCommit(target);
  assert.equal(snapshot.commit.id, fixture.head);
  assert.equal(snapshot.commit.subject, "Change example");
  assert.equal(snapshot.commit.parent, fixture.root);
  assert.match(snapshot.sources.find((source) => source.kind === "patch")?.text, /\+after/u);
  assert.equal((await readGitBlob(fixture.repository, fixture.head, "example.txt")).text, "after\n");
  assert.equal((await revalidateLocalGitSnapshot(snapshot)).matches, true);
});

test("로컬 바이너리 속성이 커밋된 텍스트의 줄 수와 패치를 숨기지 않는다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const target = { commit: fixture.head, repositoryPath: fixture.repository };
  const baseline = await collectLocalGitCommit(target);
  await writeFile(join(fixture.repository, ".gitattributes"), "*.txt -diff\n");
  await writeFile(join(fixture.repository, ".git", "info", "attributes"), "*.txt -diff\n");

  const snapshot = await collectLocalGitCommit(target);
  assert.deepEqual(snapshot.files, baseline.files);
  assert.deepEqual(snapshot.sources, baseline.sources);
});

test("바이너리 속성이 있는 이름 변경도 수집하되 실제 바이너리 본문은 제외한다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  git(fixture.repository, "mv", "example.txt", "이름 변경.txt");
  await writeFile(join(fixture.repository, "이름 변경.txt"), "after\n더\n");
  await writeFile(join(fixture.repository, "binary.txt"), Buffer.from([0, 1, 2]));
  git(fixture.repository, "add", "--", "이름 변경.txt", "binary.txt");
  git(fixture.repository, "commit", "-m", "파일 이름과 내용을 변경함");
  const target = {
    commit: git(fixture.repository, "rev-parse", "HEAD"),
    repositoryPath: fixture.repository,
  };
  const baseline = await collectLocalGitCommit(target);
  await writeFile(join(fixture.repository, ".gitattributes"), "*.txt -diff\n");

  const snapshot = await collectLocalGitCommit(target);
  assert.deepEqual(snapshot.files, baseline.files);
  assert.deepEqual(snapshot.sources, baseline.sources);
  assert.equal(snapshot.files.find((file) => file.path === "이름 변경.txt").previousPath, "example.txt");
  assert.equal(snapshot.files.find((file) => file.path === "binary.txt").bodyState, "metadata-only");
  assert.equal((await readGitBlob(fixture.repository, target.commit, "binary.txt")).state, "binary");
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

test("batches changed-line and blob reads across many files", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const addedPaths = Array.from(
    { length: 32 },
    (_, index) => `batch-${String(index + 1).padStart(2, "0")}.txt`,
  );
  await Promise.all(addedPaths.map((path, index) => writeFile(
    join(fixture.repository, path),
    `일괄 수집 ${index + 1}\n`,
    "utf8",
  )));
  git(fixture.repository, "add", "--", ...addedPaths);
  git(fixture.repository, "commit", "-m", "Add batch fixtures");

  const commands = [];
  const record = (arguments_) => commands.push(arguments_);
  const snapshot = await collectLocalGitCommit({
    commit: git(fixture.repository, "rev-parse", "HEAD"),
    repositoryPath: fixture.repository,
  }, {
    exec: async (command, arguments_, options) => {
      record(arguments_);
      return execFile(command, arguments_, options);
    },
    execInput: async (command, arguments_, options, input) => {
      record(arguments_);
      return execFileWithInput(command, arguments_, options, input);
    },
    locale: "ko-KR",
    localeSource: "explicit",
    theme: "system",
    themeSource: "default",
  });

  assert.equal(snapshot.files.length, addedPaths.length);
  assert.equal(commands.filter((arguments_) => arguments_.includes("--numstat")).length, 1);
  assert.equal(commands.filter((arguments_) => arguments_.includes("--batch")).length, 1);
  assert.equal(commands.filter((arguments_) => (
    arguments_.includes("cat-file")
    && (arguments_.includes("-t") || arguments_.includes("-s"))
  )).length, 0);
  assert.ok(commands.length <= addedPaths.length + 15, `${commands.length} Git commands`);
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
