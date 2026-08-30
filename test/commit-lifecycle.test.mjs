import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";

import { main as runCommitCommand, parseDiffArguments } from "../plugins/hope/skills/commit/scripts/cli.mjs";
import { finishDiff } from "../plugins/hope/skills/commit/scripts/index.mjs";
import { finalizeReview } from "../plugins/hope/skills/commit/scripts/finalize.mjs";
import { digestJson } from "../plugins/hope/review-core/hash.mjs";
import {
  appendDiffRunPlan,
  cleanupExpiredRuns,
  loadDiffRun,
  removeDiffRun,
  writeNewJson,
} from "../plugins/hope/skills/commit/scripts/run.mjs";
import {
  registerTestTemporaryDirectoryCleanup,
} from "../test-support/temporary-directory.mjs";

const createTestTemporaryDirectory = registerTestTemporaryDirectoryCleanup(after);

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], {
    encoding: "utf8",
  }).trim();
}

async function createRepositoryFixture(repository) {
  execFileSync("git", ["init", "--quiet", repository]);
  git(repository, "config", "user.name", "Hope Commit 테스트");
  git(repository, "config", "user.email", "hope-commit@example.invalid");

  const sourcePath = join(repository, "retry.mjs");
  await writeFile(
    sourcePath,
    "export function finalError() {\n  return new Error(\"알 수 없는 오류\");\n}\n",
    "utf8",
  );
  git(repository, "add", "retry.mjs");
  git(repository, "commit", "--quiet", "-m", "재시도 오류 반환 추가");

  await writeFile(
    sourcePath,
    "export function finalError(error) {\n  return error;\n}\n",
    "utf8",
  );
  git(repository, "add", "retry.mjs");
  git(
    repository,
    "commit",
    "--quiet",
    "-m",
    "마지막 재시도 오류 반환",
    "-m",
    "실제 오류를 호출자에게 반환합니다.",
  );

  return git(repository, "rev-parse", "HEAD");
}

function commandDependencies(temporaryRoot) {
  return {
    stdout: { write() {} },
    temporaryRoot,
  };
}

async function checkpointEveryWindow(runPath, dependencies) {
  let window = await runCommitCommand([
    "inspect-window",
    "--run",
    runPath,
    "--page",
    "1",
  ], dependencies);

  while (window) {
    const checkpoint = await runCommitCommand([
      "checkpoint-window",
      "--run",
      runPath,
      "--page",
      String(window.startPage),
    ], dependencies);
    window = checkpoint.nextWindow;
  }
}

function evidenceForLine(source, text) {
  const line = source.text.split("\n").findIndex((value) => value === text) + 1;
  assert.ok(line > 0, `${source.kind} 근거에서 '${text}' 줄을 찾을 수 없습니다.`);
  return { endLine: line, sourceId: source.id, startLine: line };
}

function omittedTeachingAid(reason) {
  return { decision: "omitted", reason };
}

function makeLifecycleAnalysis(run) {
  const purposeSource = run.snapshot.sources.find(
    (source) => source.kind === "commit-body",
  );
  const patchSource = run.snapshot.sources.find((source) => source.kind === "patch");
  assert.ok(purposeSource);
  assert.ok(patchSource);

  const before = evidenceForLine(patchSource, "-export function finalError() {");
  const after = evidenceForLine(
    patchSource,
    "+export function finalError(error) {",
  );
  const purpose = evidenceForLine(
    purposeSource,
    "실제 오류를 호출자에게 반환합니다.",
  );

  return {
    codeSteps: [{
      basis: "code",
      evidence: [after],
      text: "함수가 전달받은 오류 객체를 그대로 반환합니다.",
      title: "실제 오류 반환",
    }],
    contextChecks: [
      {
        basis: "code",
        evidence: [before, after],
        explanation: "변경 전후의 반환 동작을 확인했습니다.",
        limitIds: [],
        status: "checked",
        subject: "변경된 반환 동작",
      },
      {
        basis: "unknown",
        evidence: [],
        explanation: "변경하지 않은 호출자는 수집하지 않았습니다.",
        limitIds: ["limit-1"],
        status: "limited",
        subject: "변경하지 않은 호출자",
      },
      {
        basis: "unknown",
        evidence: [],
        explanation: "테스트와 CI 실행 결과는 수집하지 않았습니다.",
        limitIds: ["limit-2"],
        status: "limited",
        subject: "테스트와 CI 결과",
      },
    ],
    coreChange: {
      after: {
        basis: "code",
        evidence: [after],
        text: "함수가 받은 오류 객체를 반환합니다.",
      },
      before: {
        basis: "code",
        evidence: [before],
        text: "함수가 오류 인수 없이 일반 오류를 만들었습니다.",
      },
      details: [{
        basis: "code",
        evidence: [before, after],
        text: "마지막 오류를 새 오류로 바꾸지 않습니다.",
      }],
      why: {
        basis: "inferred",
        evidence: [before, after],
        text: "호출자가 실제 실패 원인을 확인할 수 있습니다.",
      },
    },
    fileDispositions: run.snapshot.files.map((file) => ({
      disposition: "explained",
      fileId: file.id,
    })),
    limitImpacts: run.snapshot.limits.map((limit) => ({
      impact: limit.kind === "verification"
        ? "실행 결과는 이 검토의 결론에 포함하지 않습니다."
        : "변경하지 않은 호출자의 동작은 판단하지 않습니다.",
      limitId: limit.id,
      material: false,
    })),
    locale: run.snapshot.settings.locale,
    purpose: {
      basis: "stated",
      evidence: [purpose],
      text: "실제 오류를 호출자에게 반환합니다.",
    },
    reviewItems: [],
    runId: run.manifest.runId,
    schemaVersion: 3,
    snapshotDigest: run.snapshot.digest,
    teachingAids: {
      microworld: omittedTeachingAid("한 반환문 변경에는 실행 모형이 필요하지 않습니다."),
      quiz: omittedTeachingAid("핵심 변경이 짧아 확인 문제가 필요하지 않습니다."),
      visual: omittedTeachingAid("변경 전후 설명만으로 반환 동작을 비교할 수 있습니다."),
    },
    title: {
      basis: "code",
      evidence: [before, after],
      text: "마지막 재시도 오류가 호출자에게 전달됩니다.",
    },
  };
}

function appendContextLimit(snapshot, suffix = "retry") {
  const { digest: _digest, ...previous } = snapshot;
  const value = {
    ...previous,
    limits: [
      ...snapshot.limits,
      {
        id: `limit-${snapshot.limits.length + 1}`,
        kind: "context-unavailable",
        reason: "요청한 맥락을 찾지 못했습니다.",
        reasonKind: "not-found",
        revision: snapshot.snapshot.head,
        subject: `src/${suffix}.mjs`,
      },
    ],
  };
  return { ...value, digest: digestJson(value) };
}

function appendOptions(snapshot, temporaryRoot, extra = {}) {
  return {
    expectedSnapshotDigest: snapshot.digest,
    previousLimitCount: snapshot.limits.length,
    previousSourceCount: snapshot.sources.length,
    temporaryRoot,
    ...extra,
  };
}

function writeJsonThenFailWhen(matches) {
  let failed = false;
  return async (path, value) => {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    if (!failed && matches(path)) {
      failed = true;
      const error = new Error("계획 파일 기록 직후 중단됨");
      error.code = "EIO";
      throw error;
    }
  };
}

function interruptedJsonOpen(partial) {
  return async (path, flags, mode) => {
    const handle = await open(path, flags, mode);
    return {
      close: async () => await handle.close(),
      sync: async () => await handle.sync(),
      writeFile: async () => {
        if (partial.length > 0) await handle.writeFile(partial, "utf8");
        const error = new Error("임시 JSON 기록 중단");
        error.code = "EIO";
        throw error;
      },
    };
  };
}

async function createInspectedCommitRun(temporaryRoot, { outputPath } = {}) {
  const commit = await createRepositoryFixture(temporaryRoot);
  const dependencies = commandDependencies(temporaryRoot);
  const arguments_ = [
    "prepare",
    commit,
    "--repo",
    temporaryRoot,
    "--host-locale",
    "ko-KR",
  ];
  if (outputPath) arguments_.push("--output", outputPath);
  const prepared = await runCommitCommand(arguments_, dependencies);
  await checkpointEveryWindow(prepared.path, dependencies);
  const run = await loadDiffRun(prepared.path, { temporaryRoot });
  return { commit, dependencies, prepared, run };
}

test("Commit Diff 새 JSON 기록이 중단되면 빈 target이나 잘린 target을 남기지 않는다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory(
    "hope-commit-atomic-json-",
  );
  for (const [name, partial] of [
    ["empty", ""],
    ["truncated", "{\"complete\":"],
  ]) {
    const target = join(temporaryRoot, `${name}.json`);
    await assert.rejects(
      writeNewJson(target, { complete: true }, {
        openFile: interruptedJsonOpen(partial),
      }),
      /임시 JSON 기록 중단/u,
    );
    await assert.rejects(access(target), /ENOENT/u);

    await writeNewJson(target, { complete: true });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
      complete: true,
    });
  }
});

test("Commit Diff가 준비한 상태를 검증하고 재검증한 뒤 HTML을 게시한다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-commit-lifecycle-");
  const commit = await createRepositoryFixture(temporaryRoot);
  const outputPath = join(temporaryRoot, "review.html");
  const dependencies = commandDependencies(temporaryRoot);

  const prepared = await runCommitCommand([
    "prepare",
    commit,
    "--repo",
    temporaryRoot,
    "--host-locale",
    "ko-KR",
    "--output",
    outputPath,
  ], dependencies);
  assert.equal(prepared.commit.id, commit);
  await access(prepared.path);

  await checkpointEveryWindow(prepared.path, dependencies);
  const ledger = await runCommitCommand([
    "ledger",
    "--run",
    prepared.path,
    "--page",
    "1",
  ], dependencies);
  assert.equal(ledger.coverage.checkpointCount, prepared.pageCount);

  const run = await loadDiffRun(prepared.path, { temporaryRoot });
  await writeFile(
    prepared.analysisPath,
    `${JSON.stringify(makeLifecycleAnalysis(run), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );

  const validated = await runCommitCommand([
    "validate",
    "--run",
    prepared.path,
  ], dependencies);
  assert.equal(validated.valid, true);

  const finished = await runCommitCommand([
    "finish",
    "--run",
    prepared.path,
  ], dependencies);
  assert.equal(finished.commit.id, commit);
  assert.equal(finished.outputPath, outputPath);
  assert.equal(finished.snapshotDigest, prepared.snapshotDigest);
  assert.match(finished.revalidatedAt, /^\d{4}-\d{2}-\d{2}T/u);
  assert.match(await readFile(outputPath, "utf8"), /<!doctype html>/iu);
  await assert.rejects(access(prepared.path), (error) => error.code === "ENOENT");
});

for (const kind of ["빈 커밋", "바이너리", "서브모듈", "비공개 파일"]) {
  test(`${kind}만 있는 변경은 분석 실행을 만들기 전에 중단한다`, async () => {
    const temporaryRoot = await createTestTemporaryDirectory("hope-commit-unsupported-");
    const base = await createRepositoryFixture(temporaryRoot);
    if (kind === "바이너리") {
      await writeFile(join(temporaryRoot, "image.bin"), Buffer.from([0, 1, 2]));
      git(temporaryRoot, "add", "image.bin");
    } else if (kind === "서브모듈") {
      git(temporaryRoot, "update-index", "--add", "--cacheinfo", `160000,${base},vendor`);
    } else if (kind === "비공개 파일") {
      await writeFile(join(temporaryRoot, ".env"), "PASSWORD=fixture-value\n");
      git(temporaryRoot, "add", ".env");
    }
    git(temporaryRoot, "commit", "--allow-empty", "-m", "검토 본문 없는 변경");
    const commit = git(temporaryRoot, "rev-parse", "HEAD");
    const entries = await readdir(temporaryRoot);

    await assert.rejects(runCommitCommand([
      "prepare", commit, "--repo", temporaryRoot, "--host-locale", "ko-KR",
    ], commandDependencies(temporaryRoot)), /검토할 수 있는 텍스트 변경 파일이 없습니다/u);
    assert.deepEqual(await readdir(temporaryRoot), entries);
  });
}

test("Git 접근 오류 뒤 분석을 보존하고 같은 실행에서 발행을 재시도한다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-commit-revalidation-");
  const outputPath = join(temporaryRoot, "review.html");
  const { prepared, run, dependencies } = await createInspectedCommitRun(temporaryRoot, { outputPath });
  const analysis = `${JSON.stringify(makeLifecycleAnalysis(run), null, 2)}\n`;
  await writeFile(prepared.analysisPath, analysis, { flag: "wx", mode: 0o600 });
  const failGit = async () => {
    throw Object.assign(new Error("재현용 Git 접근 오류"), { code: "EACCES" });
  };

  await assert.rejects(finishDiff(prepared.path, {
    ...dependencies,
    git: failGit,
    gitInput: failGit,
  }), (error) => (
    error.code === "HOPE_DIFF_REVALIDATION_RETRYABLE" && error.canRetry === true
  ));
  assert.equal(await readFile(prepared.analysisPath, "utf8"), analysis);
  assert.equal((await loadDiffRun(prepared.path, { temporaryRoot })).snapshot.digest, prepared.snapshotDigest);
  await assert.rejects(access(outputPath), (error) => error.code === "ENOENT");

  const finished = await finishDiff(prepared.path, dependencies);
  assert.equal(finished.outputPath, outputPath);
  assert.match(await readFile(outputPath, "utf8"), /<!doctype html>/iu);
  await assert.rejects(access(prepared.path), (error) => error.code === "ENOENT");
});

test("저장 경로 충돌 뒤 분석을 보존하고 새 경로로 발행한다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-commit-output-retry-");
  const outputPath = join(temporaryRoot, "occupied.html");
  const { prepared, run, dependencies } = await createInspectedCommitRun(temporaryRoot, { outputPath });
  const analysis = `${JSON.stringify(makeLifecycleAnalysis(run), null, 2)}\n`;
  await writeFile(prepared.analysisPath, analysis, { flag: "wx", mode: 0o600 });
  await runCommitCommand(["validate", "--run", prepared.path], dependencies);
  await writeFile(outputPath, "다른 작업에서 만든 파일", { flag: "wx" });

  for (const options of [[], ["--output", outputPath], ["--output", join(prepared.path, "review.html")]]) {
    await assert.rejects(
      runCommitCommand(["finish", "--run", prepared.path, ...options], dependencies),
      (error) => error.code === "HOPE_DIFF_PUBLICATION_RETRYABLE" && error.canRetry === true,
    );
    assert.equal(await readFile(prepared.analysisPath, "utf8"), analysis);
    assert.equal(await readFile(outputPath, "utf8"), "다른 작업에서 만든 파일");
  }

  const newOutputPath = join(temporaryRoot, "review.html");
  const finished = await runCommitCommand([
    "finish", "--run", prepared.path, "--output", newOutputPath,
  ], dependencies);
  assert.equal(finished.outputPath, newOutputPath);
  assert.equal(finished.snapshotDigest, prepared.snapshotDigest);
  assert.match(await readFile(newOutputPath, "utf8"), /<!doctype html>/iu);
  assert.equal(await readFile(outputPath, "utf8"), "다른 작업에서 만든 파일");
  await assert.rejects(access(prepared.path), (error) => error.code === "ENOENT");
});

for (const overrideOutput of [false, true]) {
  test(`${overrideOutput ? "새" : "기본"} 저장 폴더가 임시 분석 폴더를 가리키면 분석을 보존하고 중단한다`, async () => {
    const temporaryRoot = await createTestTemporaryDirectory("hope-commit-output-redirect-");
    const outputDirectory = join(temporaryRoot, "output");
    const originalDirectory = join(temporaryRoot, "original-output");
    await mkdir(outputDirectory);
    const outputPath = join(outputDirectory, "review.html");
    const { prepared, run, dependencies } = await createInspectedCommitRun(temporaryRoot, { outputPath });
    const analysis = `${JSON.stringify(makeLifecycleAnalysis(run), null, 2)}\n`;
    await writeFile(prepared.analysisPath, analysis, { flag: "wx", mode: 0o600 });
    await runCommitCommand(["validate", "--run", prepared.path], dependencies);
    const runEntries = await readdir(prepared.path);

    await rename(outputDirectory, originalDirectory);
    await symlink(prepared.path, outputDirectory, process.platform === "win32" ? "junction" : "dir");
    const arguments_ = ["finish", "--run", prepared.path];
    if (overrideOutput) arguments_.push("--output", outputPath);
    await assert.rejects(runCommitCommand(arguments_, dependencies), (error) => (
      error.code === "HOPE_DIFF_PUBLICATION_RETRYABLE" && error.canRetry === true
    ));
    assert.equal(await readFile(prepared.analysisPath, "utf8"), analysis);
    assert.deepEqual(await readdir(prepared.path), runEntries);
    await assert.rejects(access(outputPath), (error) => error.code === "ENOENT");

    await unlink(outputDirectory);
    await rename(originalDirectory, outputDirectory);
    const finished = await runCommitCommand(arguments_, dependencies);
    assert.equal(finished.outputPath, outputPath);
    assert.match(await readFile(outputPath, "utf8"), /<!doctype html>/iu);
    await assert.rejects(access(prepared.path), (error) => error.code === "ENOENT");
  });
}

test("저장 도중 상위 폴더가 이동하면 분석과 기존 파일을 보존하고 재시도한다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-commit-output-moved-");
  const outputDirectory = join(temporaryRoot, "output");
  await mkdir(join(outputDirectory, "reviews"), { recursive: true });
  const outputPath = join(outputDirectory, "reviews", "review.html");
  const existingPath = join(outputDirectory, "reviews", "existing.txt");
  await writeFile(existingPath, "기존 파일");
  const { prepared, run, dependencies } = await createInspectedCommitRun(temporaryRoot, { outputPath });
  const analysis = `${JSON.stringify(makeLifecycleAnalysis(run), null, 2)}\n`;
  await writeFile(prepared.analysisPath, analysis, { flag: "wx", mode: 0o600 });
  await runCommitCommand(["validate", "--run", prepared.path], dependencies);
  const movedDirectory = join(prepared.path, "moved-output");

  await assert.rejects(finishDiff(prepared.path, {
    ...dependencies,
    finalize: (bytes, options) => finalizeReview(bytes, {
      ...options,
      linkFile: async (source, target) => {
        await rename(outputDirectory, movedDirectory);
        await symlink(movedDirectory, outputDirectory, process.platform === "win32" ? "junction" : "dir");
        await link(source, target);
      },
    }),
  }), (error) => error.code === "HOPE_DIFF_PUBLICATION_RETRYABLE" && error.canRetry === true);
  assert.equal(await readFile(prepared.analysisPath, "utf8"), analysis);
  assert.equal(await readFile(existingPath, "utf8"), "기존 파일");
  assert.deepEqual(await readdir(join(movedDirectory, "reviews")), ["existing.txt"]);

  await unlink(outputDirectory);
  await rename(movedDirectory, outputDirectory);
  const finished = await finishDiff(prepared.path, dependencies);
  assert.equal(finished.outputPath, outputPath);
  assert.match(await readFile(outputPath, "utf8"), /<!doctype html>/iu);
  assert.equal(await readFile(existingPath, "utf8"), "기존 파일");
  await assert.rejects(access(prepared.path), (error) => error.code === "ENOENT");
});

test("finish 외의 실행 명령은 저장 경로 변경을 받지 않는다", () => {
  for (const command of ["inspect-window", "checkpoint-window", "ledger", "validate", "cancel"]) {
    assert.throws(() => parseDiffArguments([
      command, "--run", "run-path", "--output", "review.html",
    ]), /private Skill adapter/u);
  }
});

for (const failurePoint of ["inspection-page", "ledger-state", "manifest"]) {
  test(`Commit Diff가 ${failurePoint} 중단 뒤 같은 맥락 세대를 재시도한다`, async () => {
    const temporaryRoot = await createTestTemporaryDirectory(
      `hope-commit-plan-${failurePoint}-`,
    );
    const { prepared, run } = await createInspectedCommitRun(temporaryRoot);
    const nextSnapshot = appendContextLimit(run.snapshot, failurePoint);
    const options = appendOptions(run.snapshot, temporaryRoot, {
      contextOperation: {
        collected: 0,
        limitsAdded: 1,
        requestIds: ["context-request-1"],
      },
    });
    const failure = new Error("계획 반영 직후 중단됨");
    failure.code = "EIO";
    const failingOptions = failurePoint === "manifest"
      ? {
          ...options,
          replaceManifest: async (path, value) => {
            await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
              mode: 0o600,
            });
            throw failure;
          },
        }
      : {
          ...options,
          writeJson: writeJsonThenFailWhen((path) => (
            failurePoint === "inspection-page"
              ? /\/page\.[a-f0-9]{64}\.1\.json$/u.test(path)
              : path.endsWith("/ledger-state.2.json")
          )),
        };

    await assert.rejects(
      appendDiffRunPlan(prepared.path, nextSnapshot, failingOptions),
      /중단됨/u,
    );
    const retried = await appendDiffRunPlan(
      prepared.path,
      nextSnapshot,
      options,
    );
    assert.equal(retried.manifest.generation, 2);
    assert.equal(retried.snapshot.digest, nextSnapshot.digest);
    await removeDiffRun(prepared.path, { temporaryRoot });
  });
}

test("Commit Diff finish가 잠금 뒤 최신 세대를 다시 읽고 보존한다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory(
    "hope-commit-finish-generation-",
  );
  const outputPath = join(temporaryRoot, "review.html");
  const { prepared, run } = await createInspectedCommitRun(temporaryRoot, {
    outputPath,
  });
  const analysis = `${JSON.stringify(makeLifecycleAnalysis(run), null, 2)}\n`;
  await writeFile(prepared.analysisPath, analysis, {
    flag: "wx",
    mode: 0o600,
  });
  const nextSnapshot = appendContextLimit(run.snapshot, "new-generation");
  let published = false;

  await assert.rejects(
    finishDiff(prepared.path, {
      claimMutation: async () => {
        await unlink(prepared.analysisPath);
        await appendDiffRunPlan(
          prepared.path,
          nextSnapshot,
          appendOptions(run.snapshot, temporaryRoot),
        );
        await writeFile(prepared.analysisPath, analysis, { mode: 0o600 });
        return {
          assertOwned: async () => {},
          release: async () => {},
        };
      },
      finalize: async () => {
        published = true;
        return { outputPath };
      },
      render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
      revalidate: async () => ({
        matches: true,
        revalidatedAt: "2026-08-27T00:01:00.000Z",
      }),
      temporaryRoot,
    }),
    /Read and checkpoint every Hope inspection page/u,
  );
  assert.equal(published, false);
  const retained = await loadDiffRun(prepared.path, { temporaryRoot });
  assert.equal(retained.manifest.generation, 2);
  await removeDiffRun(prepared.path, { temporaryRoot });
});

test("Commit Diff finish가 같은 runId의 교체된 디렉터리를 거부한다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory(
    "hope-commit-finish-identity-",
  );
  const { prepared, run } = await createInspectedCommitRun(temporaryRoot);
  await writeFile(
    prepared.analysisPath,
    `${JSON.stringify(makeLifecycleAnalysis(run), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  let published = false;

  await assert.rejects(
    finishDiff(prepared.path, {
      claimMutation: async () => ({
        assertOwned: async () => {},
        release: async () => {},
      }),
      finalize: async () => {
        published = true;
        return {};
      },
      loadRun: async () => ({
        ...run,
        directory: {
          dev: run.directory.dev,
          ino: run.directory.ino + 1,
          mode: run.directory.mode,
        },
      }),
      temporaryRoot,
    }),
    /ownership changed before finalization/u,
  );
  assert.equal(published, false);
  await access(prepared.path);
  await removeDiffRun(prepared.path, { temporaryRoot });
});

test("Commit Diff 만료 정리가 manifest 일부 삭제 뒤 claimed 경로를 다시 정리한다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory(
    "hope-commit-expiry-resume-",
  );
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const commit = await createRepositoryFixture(temporaryRoot);
  const prepared = await runCommitCommand([
    "prepare",
    commit,
    "--repo",
    temporaryRoot,
    "--host-locale",
    "ko-KR",
  ], {
    ...commandDependencies(temporaryRoot),
    clock: () => old,
  });
  const failed = await cleanupExpiredRuns({
    removeDirectory: async (path) => {
      await rm(join(path, "run.json"));
      throw new Error("삭제 중단");
    },
    temporaryRoot,
  });

  assert.equal(failed.preservedPaths.length, 1);
  assert.match(
    failed.preservedPaths[0],
    /\/\.remove-run-[a-f0-9]{32}-[a-f0-9]{32}$/u,
  );
  await assert.rejects(access(prepared.path), /ENOENT/u);
  const retried = await cleanupExpiredRuns({ temporaryRoot });
  assert.deepEqual(retried, {
    preservedPaths: [],
    removedPaths: [failed.preservedPaths[0]],
  });
});

test("Commit Diff가 손상된 실행 기록과 안전하지 않은 상태 경로를 거부한다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory(
    "hope-commit-corrupt-run-",
  );
  const { prepared, run } = await createInspectedCommitRun(temporaryRoot);
  const manifestPath = join(prepared.path, "run.json");
  const snapshotPath = join(prepared.path, "snapshot.json");

  await writeFile(manifestPath, '{"owner":', "utf8");
  await assert.rejects(
    loadDiffRun(prepared.path, { temporaryRoot }),
    /run manifest is not valid JSON/u,
  );

  await writeFile(
    manifestPath,
    `${JSON.stringify({
      ...run.manifest,
      ledgerStateFile: "../checkpoint-state.json",
    }, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    loadDiffRun(prepared.path, { temporaryRoot }),
    /checkpoint state pointer is unsafe/u,
  );

  await writeFile(
    manifestPath,
    `${JSON.stringify(run.manifest, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    snapshotPath,
    `${JSON.stringify({ ...run.snapshot, repository: "변조된 저장소" }, null, 2)}\n`,
    "utf8",
  );
  await assert.rejects(
    loadDiffRun(prepared.path, { temporaryRoot }),
    /snapshot digest does not match/u,
  );
});

test("Commit Diff가 기존 출력 파일을 바꾸지 않는다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-commit-output-");
  const commit = await createRepositoryFixture(temporaryRoot);
  const outputPath = join(temporaryRoot, "review.html");
  const existing = "기존 검토 결과\n";
  await writeFile(outputPath, existing, "utf8");

  await assert.rejects(
    runCommitCommand([
      "prepare",
      commit,
      "--repo",
      temporaryRoot,
      "--host-locale",
      "ko-KR",
      "--output",
      outputPath,
    ], commandDependencies(temporaryRoot)),
    /기존|existing output|did not replace/u,
  );
  assert.equal(await readFile(outputPath, "utf8"), existing);
});
