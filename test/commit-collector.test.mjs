import assert from "node:assert/strict";
import { execFile as execFileCallback, execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  collectLocalGitCommit,
  readGitBlob,
  revalidateLocalGitSnapshot,
  resolveCommit,
} from "../plugins/hope/skills/commit/scripts/git.mjs";
import {
  parseCommitTargetArgument,
  resolveLocalCommitTarget,
} from "../plugins/hope/skills/commit/scripts/target.mjs";
import { buildInspectionPages } from "../plugins/hope/skills/commit/scripts/run.mjs";
import { patchLineLocations } from "../plugins/hope/skills/commit/scripts/code-evidence.mjs";

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

async function repositoryFixture(repositoryPath) {
  const repository = repositoryPath ?? await mkdtemp(join(tmpdir(), "hope-commit-test-"));
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

for (const [label, refCommand] of [["브랜치", "branch"], ["태그", "tag"]]) {
  test(`짧은 커밋 ID와 같은 이름의 ${label}가 있어도 해당 커밋 객체를 검토한다`, async (t) => {
    const fixture = await repositoryFixture();
    t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
    const shortId = fixture.head.slice(0, 8);
    git(fixture.repository, refCommand, shortId, fixture.root);
    const request = { commit: shortId, repositoryPath: fixture.repository };

    const target = await resolveLocalCommitTarget(request);
    const snapshot = await collectLocalGitCommit(request);
    assert.equal(target.commit, fixture.head);
    assert.equal(snapshot.commit.id, fixture.head);
    assert.equal(snapshot.commit.parent, fixture.root);
    assert.match(snapshot.sources.find((source) => source.kind === "patch")?.text, /\+after/u);
  });
}

test("일치하는 커밋 객체가 없으면 같은 이름의 태그를 대신 검토하지 않는다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const missingId = "deadbeef";
  assert.equal(git(fixture.repository, "rev-parse", `--disambiguate=${missingId}`), "");
  git(fixture.repository, "tag", missingId, fixture.head);
  const request = { commit: missingId, repositoryPath: fixture.repository };

  await assert.rejects(resolveLocalCommitTarget(request), /일치하는 커밋 객체가 없습니다/u);
  await assert.rejects(collectLocalGitCommit(request), /일치하는 커밋 객체가 없습니다/u);
});

test("접두사가 같은 객체 중 커밋이 하나일 때만 선택한다", async () => {
  const candidates = [`abcd${"1".repeat(36)}`, `abcd${"2".repeat(36)}`];
  let types = ["commit", "blob"];
  const options = {
    exec: async () => ({ stdout: `${candidates.join("\n")}\n` }),
    execInput: async () => ({ stdout: `${types.join("\n")}\n` }),
  };
  assert.equal(await resolveCommit("repository", "ABCD", options), candidates[0]);
  types = ["commit", "commit"];
  await assert.rejects(resolveCommit("repository", "abcd", options), /더 긴 커밋 ID/u);
});

test("파일과 주석 태그의 객체 ID를 커밋 ID로 받지 않는다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  git(fixture.repository, "tag", "-a", "review", "-m", "주석 태그", fixture.head);
  const objects = [
    git(fixture.repository, "rev-parse", "HEAD:example.txt"),
    git(fixture.repository, "rev-parse", "refs/tags/review"),
  ];
  for (const commit of objects) {
    const request = { commit, repositoryPath: fixture.repository };
    await assert.rejects(resolveLocalCommitTarget(request), /일치하는 커밋 객체가 없습니다/u);
    await assert.rejects(collectLocalGitCommit(request), /일치하는 커밋 객체가 없습니다/u);
  }
});

for (const [label, suffix] of [["공백", " "], ["줄바꿈", "\n"]]) {
  test(`저장소 경로의 끝 ${label}을 대상 확인과 수집에서 보존한다`, {
    skip: process.platform === "win32" && "Windows에서 지원하지 않는 폴더명입니다.",
  }, async (t) => {
    const temporaryRoot = await mkdtemp(join(await realpath(tmpdir()), "hope-commit-path-"));
    t.after(async () => rm(temporaryRoot, { force: true, recursive: true }));
    const repository = join(temporaryRoot, `저장소${suffix}`);
    await mkdir(repository);
    const fixture = await repositoryFixture(repository);
    const target = await resolveLocalCommitTarget({ commit: fixture.head, repositoryPath: repository });

    assert.equal(target.repositoryPath, repository);
    const snapshot = await collectLocalGitCommit(target);
    assert.equal(snapshot.repository.path, repository);
    assert.equal(snapshot.commit.id, fixture.head);
    assert.match(snapshot.sources.find((source) => source.kind === "patch").text, /\+after/u);
    assert.equal((await revalidateLocalGitSnapshot(snapshot)).matches, true);
  });
}

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

test("단독 CR은 표시하되 원본과 패치의 줄 수를 늘리지 않는다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  git(fixture.repository, "config", "core.autocrlf", "false");
  const path = join(fixture.repository, "example.txt");
  await writeFile(path, "first\rfragment\nold\r\n");
  git(fixture.repository, "add", "example.txt");
  git(fixture.repository, "commit", "-m", "CR 포함 본문 추가");
  await writeFile(path, "first\rfragment\nchanged\r\n");
  git(fixture.repository, "add", "example.txt");
  git(fixture.repository, "commit", "-m", "CR 포함 본문 변경");
  const commit = git(fixture.repository, "rev-parse", "HEAD");

  const blob = await readGitBlob(fixture.repository, commit, "example.txt");
  assert.equal(blob.text, "first\\u000Dfragment\nchanged\n");
  const snapshot = await collectLocalGitCommit({ commit, repositoryPath: fixture.repository });
  const patch = snapshot.sources.find((source) => source.kind === "patch").text;
  assert.match(patch, /@@ -1,2 \+1,2 @@\n first\\u000Dfragment\n-old\n\+changed\n/u);
  assert.doesNotMatch(patch, /\r/u);
});

test("Git 빈 줄 표시 설정과 관계없이 같은 패치와 줄 번호를 수집한다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const path = join(fixture.repository, "example.txt");
  await writeFile(path, "start();\n\nold();\nend();\n");
  git(fixture.repository, "add", "example.txt");
  git(fixture.repository, "commit", "-m", "빈 줄 포함 코드 추가");
  await writeFile(path, "start();\n\nnext();\nend();\n");
  git(fixture.repository, "add", "example.txt");
  git(fixture.repository, "commit", "-m", "빈 줄 뒤의 코드 변경");
  const commit = git(fixture.repository, "rev-parse", "HEAD");
  const target = { commit, repositoryPath: fixture.repository };
  git(fixture.repository, "config", "diff.suppressBlankEmpty", "false");
  const baseline = await collectLocalGitCommit(target);
  git(fixture.repository, "config", "diff.suppressBlankEmpty", "true");
  const snapshot = await collectLocalGitCommit(target);
  const patch = snapshot.sources.find((source) => source.kind === "patch").text;

  assert.equal(patch, baseline.sources.find((source) => source.kind === "patch").text);
  const lines = patch.split("\n");
  const locations = patchLineLocations(lines);
  assert.deepEqual(locations[lines.indexOf("-old();")], { kind: "removed", oldLine: 3 });
  assert.deepEqual(locations[lines.indexOf("+next();")], { kind: "added", newLine: 3 });
  assert.equal(git(fixture.repository, "config", "--get", "diff.suppressBlankEmpty"), "true");
});

test("서명 표시 설정이 켜져 있어도 수집 중 서명 확인 프로그램을 실행하지 않는다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  const verifier = join(fixture.repository, "verifier.sh");
  const marker = join(fixture.repository, "signature-program-ran");
  await writeFile(verifier, "#!/bin/sh\nprintf invoked > signature-program-ran\nexit 1\n");
  await chmod(verifier, 0o700);
  const original = git(fixture.repository, "cat-file", "commit", fixture.head);
  const signedCommit = original.replace("\n\n",
    "\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture-signature\n -----END PGP SIGNATURE-----\n\n");
  const commit = gitWithInput(fixture.repository, ["hash-object", "-t", "commit", "-w", "--stdin"], signedCommit);
  git(fixture.repository, "config", "gpg.program", verifier);
  git(fixture.repository, "config", "log.showSignature", "true");

  git(fixture.repository, "show", "--show-signature", "-s", "--format=%s", commit);
  await access(marker);
  await unlink(marker);

  const snapshot = await collectLocalGitCommit({ commit, repositoryPath: fixture.repository });
  assert.equal(snapshot.commit.subject, "Change example");
  await assert.rejects(access(marker), (error) => error.code === "ENOENT");
});

test("Git 출력 인코딩 설정과 관계없이 한글 커밋 정보를 보존한다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  git(fixture.repository, "config", "user.name", "검토 테스트");
  await writeFile(join(fixture.repository, "example.txt"), "변경한 내용\n");
  git(fixture.repository, "add", "example.txt");
  git(fixture.repository, "commit", "-m", "한글 변경 제목", "-m", "본문도 한글로 보존합니다.");
  const commit = git(fixture.repository, "rev-parse", "HEAD");
  git(fixture.repository, "config", "i18n.logOutputEncoding", "CP949");

  const snapshot = await collectLocalGitCommit({ commit, repositoryPath: fixture.repository });
  assert.equal(snapshot.commit.subject, "한글 변경 제목");
  assert.equal(snapshot.commit.body, "본문도 한글로 보존합니다.");
  assert.equal(snapshot.commit.author, "검토 테스트");
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

for (const [label, beforeMode, afterMode, additions, deletions] of [
  ["심볼릭 링크에서 일반 파일", "120000", "100644", 2, 1],
  ["일반 파일에서 심볼릭 링크", "100644", "120000", 1, 2],
]) {
  test(`-diff 속성이 있어도 ${label}로 바뀐 줄 수를 합산한다`, async (t) => {
    const fixture = await repositoryFixture();
    t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
    const objects = {
      "100644": gitWithInput(fixture.repository, ["hash-object", "-w", "--stdin"], "first line\nsecond line\n"),
      "120000": gitWithInput(fixture.repository, ["hash-object", "-w", "--stdin"], "target.txt"),
    };
    for (const mode of [beforeMode, afterMode]) {
      git(fixture.repository, "update-index", "--add", "--cacheinfo", `${mode},${objects[mode]},entry.txt`);
      git(fixture.repository, "commit", "--quiet", "-m", `${label} 형식 변경 확인`);
    }
    const target = {
      commit: git(fixture.repository, "rev-parse", "HEAD"),
      repositoryPath: fixture.repository,
    };
    const baseline = await collectLocalGitCommit(target);
    assert.equal(baseline.files.length, 1);
    assert.equal(baseline.files[0].providerStatus, "changed");
    assert.equal(baseline.files[0].additions, additions);
    assert.equal(baseline.files[0].deletions, deletions);

    await writeFile(join(fixture.repository, ".gitattributes"), "*.txt -diff\n");
    const snapshot = await collectLocalGitCommit(target);
    assert.deepEqual(snapshot.files, baseline.files);
    assert.deepEqual(snapshot.sources, baseline.sources);
    assert.ok(buildInspectionPages(snapshot).length > 0);
  });
}

test("일반 변경 목록의 중복 경로는 합산하지 않고 거절한다", async (t) => {
  const fixture = await repositoryFixture();
  t.after(async () => rm(fixture.repository, { force: true, recursive: true }));
  await assert.rejects(collectLocalGitCommit({
    commit: fixture.head,
    repositoryPath: fixture.repository,
  }, {
    exec: async (command, arguments_, options) => {
      const result = await execFile(command, arguments_, options);
      if (arguments_.includes("diff") && arguments_.includes("--numstat")) {
        return { ...result, stdout: Buffer.concat([result.stdout, result.stdout]) };
      }
      return result;
    },
  }), /duplicate changed-line counts/u);
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
