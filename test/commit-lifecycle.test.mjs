import assert from "node:assert/strict";
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
import { LIMITS } from "../plugins/hope/skills/commit/scripts/constants.mjs";
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
  createRepositoryFixture,
  git,
  makeLifecycleAnalysis,
} from "../test-support/commit-fixture.mjs";
import {
  registerTestTemporaryDirectoryCleanup,
} from "../test-support/temporary-directory.mjs";

const createTestTemporaryDirectory = registerTestTemporaryDirectoryCleanup(after);

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

test("긴 커밋 본문을 요약에 중복하지 않고 근거 페이지에 나눠 담아 HTML을 만든다", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-commit-long-body-");
  await createRepositoryFixture(temporaryRoot);
  const body = [
    "실제 오류를 호출자에게 반환합니다.",
    "",
    ...Array.from({ length: 400 }, (_, index) => (
      `${index + 1}: 입력값과 반환값을 확인하는 변경 설명입니다.`
    )),
  ].join("\n");
  assert.ok(Buffer.byteLength(body, "utf8") > LIMITS.ledgerPageBytes);
  git(temporaryRoot, "commit", "--amend", "--quiet",
    "-m", "마지막 재시도 오류 반환", "-m", body);
  const commit = git(temporaryRoot, "rev-parse", "HEAD");
  const outputPath = join(temporaryRoot, "review.html");
  const dependencies = commandDependencies(temporaryRoot);
  const prepared = await runCommitCommand([
    "prepare", commit, "--repo", temporaryRoot,
    "--host-locale", "ko-KR", "--output", outputPath,
  ], dependencies);

  const pages = [];
  let window = await runCommitCommand([
    "inspect-window", "--run", prepared.path, "--page", "1",
  ], dependencies);
  while (window) {
    pages.push(...window.pages);
    const checkpoint = await runCommitCommand([
      "checkpoint-window", "--run", prepared.path,
      "--page", String(window.startPage),
    ], dependencies);
    window = checkpoint.nextWindow;
  }
  assert.equal(pages.length, prepared.pageCount);
  for (const page of pages) {
    assert.ok(Buffer.byteLength(JSON.stringify(page), "utf8") <= LIMITS.inspectionPageBytes);
  }
  const summary = pages.find((page) => page.kind === "summary").value;
  assert.equal(summary.commit.id, commit);
  assert.equal(summary.commit.subject, "마지막 재시도 오류 반환");
  assert.equal(Object.hasOwn(summary.commit, "body"), false);
  const bodyChunks = pages
    .filter((page) => page.kind === "sources")
    .flatMap((page) => page.value.sources)
    .filter((source) => source.sourceKind === "commit-body");
  assert.ok(bodyChunks.length > 1);
  assert.equal(bodyChunks.map((source) => source.text).join("\n"), body);

  const ledger = await runCommitCommand([
    "ledger", "--run", prepared.path, "--page", "1",
  ], dependencies);
  const overview = ledger.reviewContext.find((entry) => entry.kind === "overview");
  assert.equal(overview.commit.id, commit);
  assert.equal(Object.hasOwn(overview.commit, "body"), false);
  const run = await loadDiffRun(prepared.path, { temporaryRoot });
  assert.equal(run.snapshot.commit.body, body);
  await writeFile(prepared.analysisPath, JSON.stringify(makeLifecycleAnalysis(run)), {
    flag: "wx", mode: 0o600,
  });
  const validated = await runCommitCommand([
    "validate", "--run", prepared.path,
  ], dependencies);
  assert.equal(validated.valid, true);

  await runCommitCommand(["finish", "--run", prepared.path], dependencies);
  assert.match(await readFile(outputPath, "utf8"), /<!doctype html>/iu);
  await assert.rejects(access(prepared.path), (error) => error.code === "ENOENT");
});

for (const binaryCount of [239, LIMITS.changedFiles - 1]) {
  test(`텍스트 변경과 바이너리 ${binaryCount}개의 제외 사유를 기록하고 HTML을 만든다`, async () => {
    const temporaryRoot = await createTestTemporaryDirectory("hope-commit-many-limits-");
    await createRepositoryFixture(temporaryRoot);
    const paths = Array.from({ length: binaryCount }, (_, index) => `image-${index}.bin`);
    await Promise.all(paths.map((path) => (
      writeFile(join(temporaryRoot, path), Buffer.from([0, 1, 2]))
    )));
    git(temporaryRoot, "add", ...paths);
    git(temporaryRoot, "commit", "--amend", "--no-edit", "--quiet");
    const commit = git(temporaryRoot, "rev-parse", "HEAD");
    const outputPath = join(temporaryRoot, "review.html");
    const dependencies = commandDependencies(temporaryRoot);
    const prepared = await runCommitCommand([
      "prepare", commit, "--repo", temporaryRoot,
      "--host-locale", "ko-KR", "--output", outputPath,
    ], dependencies);
    await checkpointEveryWindow(prepared.path, dependencies);
    const run = await loadDiffRun(prepared.path, { temporaryRoot });
    assert.equal(run.snapshot.files.length, binaryCount + 1);
    assert.equal(run.snapshot.limits.length, binaryCount + 2);

    const analysis = makeLifecycleAnalysis(run);
    analysis.fileDispositions = run.snapshot.files
      .filter((file) => file.bodyState === "included")
      .map((file) => ({ disposition: "explained", fileId: file.id }));
    analysis.contextChecks.push({
      basis: "unknown",
      evidence: [],
      explanation: "바이너리 본문은 검토하지 않고 파일 변경 여부만 확인합니다.",
      limitIds: run.snapshot.limits
        .filter((limit) => limit.kind === "file-unavailable")
        .map((limit) => limit.id),
      status: "limited",
      subject: "바이너리 파일 본문",
    });
    await writeFile(prepared.analysisPath, JSON.stringify(analysis), {
      flag: "wx", mode: 0o600,
    });
    const validated = await runCommitCommand([
      "validate", "--run", prepared.path,
    ], dependencies);
    assert.equal(validated.valid, true);
    const schema = JSON.parse(await readFile(prepared.analysisSchemaPath, "utf8"));
    assert.equal(
      schema.properties.contextChecks.items.properties.limitIds.maxItems,
      LIMITS.changedFiles + 2 + LIMITS.contextFiles,
    );

    await runCommitCommand(["finish", "--run", prepared.path], dependencies);
    const html = await readFile(outputPath, "utf8");
    assert.match(html, /<!doctype html>/iu);
    assert.ok(html.includes(paths.at(-1)));
    await assert.rejects(access(prepared.path), (error) => error.code === "ENOENT");
  });
}

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
