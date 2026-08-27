import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  access,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";

import { main as runCommitCommand } from "../plugins/hope-commit/skills/commit/scripts/cli.mjs";
import { loadDiffRun } from "../plugins/hope-commit/skills/commit/scripts/run.mjs";
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
    (source) => source.kind === "pull-request-description",
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
