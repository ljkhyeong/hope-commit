import assert from "node:assert/strict";
import {
  access,
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
import { dirname, join } from "node:path";
import test, { after } from "node:test";

import {
  ANALYSIS_VERSION,
  LIMITS,
  RUN_VERSION,
} from "../plugins/hope/skills/diff/scripts/constants.mjs";
import { revalidateGitHubSnapshot } from "../plugins/hope/skills/diff/scripts/github.mjs";
import {
  DIFF_CLEANUP_FAILED_CODE,
  DIFF_PUBLICATION_RETRYABLE_CODE,
  DIFF_REVALIDATION_RETRYABLE_CODE,
  cancelDiff,
  finishDiff,
  prepareDiff,
  validateDiff,
} from "../plugins/hope/skills/diff/scripts/index.mjs";
import { digestJson } from "../plugins/hope/review-core/hash.mjs";
import {
  appendDiffRunPlan,
  buildInspectionPages,
  checkpointDiffRunWindow,
  claimDiffRunMutation,
  cleanupExpiredRuns,
  createDiffRun,
  inspectDiffRunWindow,
  inspectionPageView,
  loadDiffRun,
  removeDiffRun,
  writeNewJson,
} from "../plugins/hope/skills/diff/scripts/run.mjs";
import { makeAnalysis, makeSnapshot } from "../test-support/diff-fixture.mjs";
import {
  registerTestTemporaryDirectoryCleanup,
} from "../test-support/temporary-directory.mjs";

const createTestTemporaryDirectory = registerTestTemporaryDirectoryCleanup(after);

async function inspectAndCheckpointAll(runPath, { temporaryRoot }) {
  let startPage = 1;
  while (true) {
    const window = await inspectDiffRunWindow(runPath, startPage, {
      temporaryRoot,
    });
    const run = await loadDiffRun(runPath, { temporaryRoot });
    await checkpointDiffRunWindow(runPath, startPage, {
      endPage: window.endPage,
      generation: run.manifest.generation,
      notes: [],
      processedPages: window.pages.map((page) => page.page),
      runId: run.manifest.runId,
      schemaVersion: 2,
      snapshotDigest: run.snapshot.digest,
      startPage,
    }, { temporaryRoot });
    if (window.endPage === run.manifest.pageCount) return;
    startPage = window.endPage + 1;
  }
}

async function createAnalyzedRun(temporaryRoot, { outputPath } = {}) {
  const snapshot = makeSnapshot();
  const created = await createDiffRun(snapshot, { outputPath, temporaryRoot });
  await inspectAndCheckpointAll(created.path, { temporaryRoot });
  await writeFile(
    created.analysisPath,
    `${JSON.stringify(makeAnalysis(snapshot, created.runId), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { created, snapshot };
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
        reason: "The requested context was unavailable",
        reasonKind: "not-found",
        revision: snapshot.snapshot.head,
        subject: `src/${suffix}.js`,
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

test("an interrupted new JSON write leaves no empty or truncated target", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-atomic-json-");
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
    assert.deepEqual(
      (await readdir(temporaryRoot)).filter((entry) => entry.endsWith(".tmp")),
      [],
    );

    await writeNewJson(target, { complete: true });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
      complete: true,
    });
  }
});

test("an invalid explicit output fails before GitHub collection", async () => {
  let collected = false;
  await assert.rejects(
    prepareDiff(
      {
        outputPath: "existing.html",
        url: "https://github.com/example/hope/pull/142",
      },
      {
        collect: async () => {
          collected = true;
          return makeSnapshot();
        },
        preflightOutput: async () => {
          throw new Error("output already exists");
        },
        resolveDisplayOptions: async () => ({
          locale: "en-US",
          localeSource: "default",
          theme: "system",
          themeSource: "default",
        }),
      },
    ),
    /output already exists/u,
  );
  assert.equal(collected, false);
});

test("a DiffRun requires every window and publishes one review", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-finish-");
  const snapshot = makeSnapshot();
  const created = await createDiffRun(snapshot, { temporaryRoot });

  await assert.rejects(
    finishDiff(created.path, { temporaryRoot }),
    /Read and checkpoint every Hope inspection page/u,
  );
  await inspectAndCheckpointAll(created.path, { temporaryRoot });
  await writeFile(
    created.analysisPath,
    `${JSON.stringify(makeAnalysis(snapshot, created.runId), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const result = await finishDiff(created.path, {
    revalidate: async () => ({
      matches: true,
      revalidatedAt: "2026-07-23T00:01:00.000Z",
    }),
    temporaryRoot,
  });

  assert.match(result.outputPath, /hope-review\.html$/u);
  await assert.rejects(loadDiffRun(created.path, { temporaryRoot }), /ENOENT/u);
});

test("snapshot revalidation starts only after rendering completes", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-order-");
  const { created } = await createAnalyzedRun(temporaryRoot);
  let rendered = false;

  await finishDiff(created.path, {
    finalize: async () => ({ outputPath: join(temporaryRoot, "review.html") }),
    render: async () => {
      rendered = true;
      return { bytes: Buffer.from("review"), digest: "d".repeat(64) };
    },
    revalidate: async () => {
      assert.equal(rendered, true);
      return {
        matches: true,
        revalidatedAt: "2026-07-23T00:01:00.000Z",
      };
    },
    temporaryRoot,
  });
});

test("a retryable revalidation failure preserves the exact run", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-retry-");
  const outputPath = join(temporaryRoot, "review.html");
  const { created } = await createAnalyzedRun(temporaryRoot, { outputPath });
  const analysis = await readFile(created.analysisPath, "utf8");

  await assert.rejects(
    finishDiff(created.path, {
      render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
      revalidate: async (snapshot) => await revalidateGitHubSnapshot(snapshot, {
        gh: async () => {
          const error = new Error("network access denied");
          error.code = 1;
          throw error;
        },
      }),
      temporaryRoot,
    }),
    (error) => {
      assert.equal(error.code, DIFF_REVALIDATION_RETRYABLE_CODE);
      assert.equal(error.canRetry, true);
      assert.equal(error.runPath, created.path);
      return true;
    },
  );
  await assert.rejects(access(outputPath), /ENOENT/u);
  assert.equal(await readFile(created.analysisPath, "utf8"), analysis);

  const result = await finishDiff(created.path, {
    render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
    revalidate: async () => ({
      matches: true,
      revalidatedAt: "2026-07-23T00:01:00.000Z",
    }),
    temporaryRoot,
  });
  assert.equal(await readFile(result.outputPath, "utf8"), "review");
});

test("a terminal revalidation failure removes the private run", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-terminal-");
  const { created } = await createAnalyzedRun(temporaryRoot);

  await assert.rejects(
    finishDiff(created.path, {
      render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
      revalidate: async () => {
        throw new Error("invalid provider response");
      },
      temporaryRoot,
    }),
    /invalid provider response/u,
  );
  await assert.rejects(loadDiffRun(created.path, { temporaryRoot }), /ENOENT/u);
});

test("invalid analysis remains repairable without a failure counter", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-repair-");
  const snapshot = makeSnapshot();
  const created = await createDiffRun(snapshot, { temporaryRoot });
  await inspectAndCheckpointAll(created.path, { temporaryRoot });
  const invalid = makeAnalysis(snapshot, created.runId);
  invalid.snapshotDigest = "0".repeat(64);
  await writeFile(created.analysisPath, `${JSON.stringify(invalid, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      validateDiff(created.path, { temporaryRoot }),
      (error) => error.code === "HOPE_ANALYSIS_INVALID" && error.canRetry,
    );
    await assert.rejects(
      finishDiff(created.path, { temporaryRoot }),
      (error) => error.code === "HOPE_ANALYSIS_INVALID" && error.canRetry,
    );
  }
  const retained = await loadDiffRun(created.path, { temporaryRoot });
  assert.equal("analysisAttempts" in retained.manifest, false);

  await writeFile(
    created.analysisPath,
    `${JSON.stringify(makeAnalysis(snapshot, created.runId), null, 2)}\n`,
    { mode: 0o600 },
  );
  const validated = await validateDiff(created.path, { temporaryRoot });
  assert.equal(validated.valid, true);
  await removeDiffRun(created.path, { temporaryRoot });
});

test("the private mutation lock has one owner and no recovery protocol", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-lock-");
  const created = await createDiffRun(makeSnapshot(), { temporaryRoot });
  const run = await loadDiffRun(created.path, { temporaryRoot });
  const claim = await claimDiffRunMutation(run);
  try {
    await assert.rejects(claimDiffRunMutation(run), (error) => error.code === "EEXIST");
    await assert.rejects(
      cancelDiff(created.path, { temporaryRoot }),
      /already being changed/u,
    );
  } finally {
    await claim.release();
  }
  const next = await claimDiffRunMutation(run);
  await next.release();
  await removeDiffRun(created.path, { temporaryRoot });
});

test("losing the private mutation lock prevents publication", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-lock-loss-");
  const { created } = await createAnalyzedRun(temporaryRoot);
  let published = false;

  await assert.rejects(
    finishDiff(created.path, {
      finalize: async () => {
        published = true;
        return {};
      },
      render: async () => {
        await unlink(join(created.path, ".change.lock"));
        return { bytes: Buffer.from("review"), digest: "d".repeat(64) };
      },
      revalidate: async () => ({
        matches: true,
        revalidatedAt: "2026-07-23T00:01:00.000Z",
      }),
      temporaryRoot,
    }),
    /mutation lock was lost/u,
  );
  assert.equal(published, false);
  await access(created.path);
  await removeDiffRun(created.path, { temporaryRoot });
});

test("a failed mutation-lock write removes the partial lock", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-lock-write-");
  const created = await createDiffRun(makeSnapshot(), { temporaryRoot });
  const run = await loadDiffRun(created.path, { temporaryRoot });
  let removedPath;

  await assert.rejects(
    claimDiffRunMutation(run, {
      openFile: async () => ({
        close: async () => {},
        sync: async () => {},
        writeFile: async () => {
          throw new Error("lock write failed");
        },
      }),
      unlinkFile: async (path) => {
        removedPath = path;
      },
    }),
    /lock write failed/u,
  );
  assert.equal(removedPath, join(created.path, ".change.lock"));
  await removeDiffRun(created.path, { temporaryRoot });
});

for (const failurePoint of ["inspection-page", "ledger-state", "manifest"]) {
  test(`a ${failurePoint} interruption can retry the same context generation`, async () => {
    const temporaryRoot = await createTestTemporaryDirectory(
      `hope-run-plan-${failurePoint}-`,
    );
    const snapshot = makeSnapshot();
    const created = await createDiffRun(snapshot, { temporaryRoot });
    await inspectAndCheckpointAll(created.path, { temporaryRoot });
    const nextSnapshot = appendContextLimit(snapshot, failurePoint);
    const options = appendOptions(snapshot, temporaryRoot, {
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
      appendDiffRunPlan(created.path, nextSnapshot, failingOptions),
      /중단됨/u,
    );
    const retried = await appendDiffRunPlan(
      created.path,
      nextSnapshot,
      options,
    );
    assert.equal(retried.manifest.generation, 2);
    assert.equal(retried.snapshot.digest, nextSnapshot.digest);
    await removeDiffRun(created.path, { temporaryRoot });
  });
}

test("a conflicting context-plan orphan is not accepted as a retry", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-plan-conflict-");
  const snapshot = makeSnapshot();
  const created = await createDiffRun(snapshot, { temporaryRoot });
  await inspectAndCheckpointAll(created.path, { temporaryRoot });
  const nextSnapshot = appendContextLimit(snapshot, "conflict");
  const options = appendOptions(snapshot, temporaryRoot);

  await assert.rejects(
    appendDiffRunPlan(created.path, nextSnapshot, {
      ...options,
      writeJson: writeJsonThenFailWhen(
        (path) => /\/page\.[a-f0-9]{64}\.1\.json$/u.test(path),
      ),
    }),
    /중단됨/u,
  );
  const pagePath = (await readdir(created.path))
    .map((name) => join(created.path, name))
    .find((path) => /\/page\.[a-f0-9]{64}\.1\.json$/u.test(path));
  assert.ok(pagePath);
  await writeFile(pagePath, `${JSON.stringify({ conflict: true })}\n`, {
    mode: 0o600,
  });
  await assert.rejects(
    appendDiffRunPlan(created.path, nextSnapshot, options),
    /conflicting inspection page/u,
  );
  await removeDiffRun(created.path, { temporaryRoot });
});

test("finish reloads the run after claiming it and preserves a newer generation", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-finish-generation-");
  const { created, snapshot } = await createAnalyzedRun(temporaryRoot);
  const analysis = await readFile(created.analysisPath, "utf8");
  const nextSnapshot = appendContextLimit(snapshot, "new-generation");
  let published = false;

  await assert.rejects(
    finishDiff(created.path, {
      claimMutation: async () => {
        await unlink(created.analysisPath);
        await appendDiffRunPlan(
          created.path,
          nextSnapshot,
          appendOptions(snapshot, temporaryRoot),
        );
        await writeFile(created.analysisPath, analysis, { mode: 0o600 });
        return {
          assertOwned: async () => {},
          release: async () => {},
        };
      },
      finalize: async () => {
        published = true;
        return { outputPath: join(temporaryRoot, "review.html") };
      },
      render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
      revalidate: async () => ({
        matches: true,
        revalidatedAt: "2026-07-23T00:01:00.000Z",
      }),
      temporaryRoot,
    }),
    /Read and checkpoint every Hope inspection page/u,
  );
  assert.equal(published, false);
  const retained = await loadDiffRun(created.path, { temporaryRoot });
  assert.equal(retained.manifest.generation, 2);
  await removeDiffRun(created.path, { temporaryRoot });
});

test("finish rejects a same-runId directory replacement after locking", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-finish-identity-");
  const { created } = await createAnalyzedRun(temporaryRoot);
  const current = await loadDiffRun(created.path, { temporaryRoot });
  let published = false;

  await assert.rejects(
    finishDiff(created.path, {
      claimMutation: async () => ({
        assertOwned: async () => {},
        release: async () => {},
      }),
      finalize: async () => {
        published = true;
        return {};
      },
      loadRun: async () => ({
        ...current,
        directory: {
          dev: current.directory.dev,
          ino: current.directory.ino + 1,
          mode: current.directory.mode,
        },
      }),
      temporaryRoot,
    }),
    /ownership changed before finalization/u,
  );
  assert.equal(published, false);
  await access(created.path);
  await removeDiffRun(created.path, { temporaryRoot });
});

test("cancelling removes only the owned private directory", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-cancel-");
  const created = await createDiffRun(makeSnapshot(), { temporaryRoot });
  await cancelDiff(created.path, { temporaryRoot });
  await assert.rejects(access(created.path), /ENOENT/u);
});

test("cancelling preserves a directory replaced during removal", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-replaced-");
  const created = await createDiffRun(makeSnapshot(), { temporaryRoot });
  const originalPath = join(dirname(created.path), ".original-run");

  await assert.rejects(
    cancelDiff(created.path, {
      onRemoveReady: async () => {
        await rename(created.path, originalPath);
        await mkdir(created.path, { mode: 0o700 });
        await writeFile(join(created.path, "foreign.txt"), "keep\n", "utf8");
      },
      temporaryRoot,
    }),
    (error) => error.code === "HOPE_DIFF_RUN_REPLACED",
  );
  assert.equal(await readFile(join(created.path, "foreign.txt"), "utf8"), "keep\n");
});

test("expiry cleanup removes exact Hope runs even with unsupported versions", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-expiry-version-");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const created = await createDiffRun(makeSnapshot(), {
    clock: () => old,
    temporaryRoot,
  });
  const manifestPath = join(created.path, "run.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.runVersion = RUN_VERSION + 100;
  manifest.analysisVersion = ANALYSIS_VERSION + 100;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const cleanup = await cleanupExpiredRuns({ temporaryRoot });
  assert.deepEqual(cleanup, {
    preservedPaths: [],
    removedPaths: [created.path],
  });
  await assert.rejects(access(created.path), /ENOENT/u);
});

test("expiry cleanup preserves a directory replaced during removal", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-expiry-race-");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const created = await createDiffRun(makeSnapshot(), {
    clock: () => old,
    temporaryRoot,
  });
  const originalPath = join(dirname(created.path), ".expired-original");
  const cleanup = await cleanupExpiredRuns({
    onRemoveReady: async () => {
      await rename(created.path, originalPath);
      await mkdir(created.path, { mode: 0o700 });
      await writeFile(join(created.path, "foreign.txt"), "keep\n", "utf8");
    },
    temporaryRoot,
  });

  assert.deepEqual(cleanup, {
    preservedPaths: [created.path],
    removedPaths: [],
  });
  assert.equal(await readFile(join(created.path, "foreign.txt"), "utf8"), "keep\n");
});

test("expiry cleanup resumes a claimed path after its manifest was partly removed", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-expiry-resume-");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const created = await createDiffRun(makeSnapshot(), {
    clock: () => old,
    temporaryRoot,
  });
  const failed = await cleanupExpiredRuns({
    removeDirectory: async (path) => {
      await rm(join(path, "run.json"));
      const error = new Error("삭제 중단");
      error.code = "EIO";
      throw Object.freeze(error);
    },
    temporaryRoot,
  });

  assert.equal(failed.removedPaths.length, 0);
  assert.equal(failed.preservedPaths.length, 1);
  assert.match(
    failed.preservedPaths[0],
    /\/\.remove-run-[a-f0-9]{32}-[a-f0-9]{32}$/u,
  );
  await assert.rejects(access(created.path), /ENOENT/u);
  await access(failed.preservedPaths[0]);

  const retried = await cleanupExpiredRuns({ temporaryRoot });
  assert.deepEqual(retried, {
    preservedPaths: [],
    removedPaths: [failed.preservedPaths[0]],
  });
  await assert.rejects(access(failed.preservedPaths[0]), /ENOENT/u);
});

test("claimed-run cleanup skips forged and symlink entries and preserves replacements", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-claimed-safety-");
  const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const created = await createDiffRun(makeSnapshot(), {
    clock: () => old,
    temporaryRoot,
  });
  const failed = await cleanupExpiredRuns({
    removeDirectory: async () => {
      throw new Error("삭제 중단");
    },
    temporaryRoot,
  });
  const claimedPath = failed.preservedPaths[0];
  const root = dirname(claimedPath);
  const forgedPath = join(
    root,
    `.remove-run-${"e".repeat(32)}-${"f".repeat(32)}`,
  );
  await mkdir(forgedPath, { mode: 0o700 });
  await writeFile(join(forgedPath, "run.json"), `${JSON.stringify({
    createdAt: old.toISOString(),
    owner: "foreign-run",
    runId: "e".repeat(32),
  })}\n`, { mode: 0o600 });
  const symlinkTarget = join(root, "claimed-symlink-target");
  await mkdir(symlinkTarget, { mode: 0o700 });
  const symlinkPath = join(
    root,
    `.remove-run-${"d".repeat(32)}-${"c".repeat(32)}`,
  );
  await symlink(symlinkTarget, symlinkPath, "dir");
  const movedPath = join(root, ".claimed-original");

  const cleanup = await cleanupExpiredRuns({
    onRemoveReady: async ({ path }) => {
      if (path !== claimedPath) return;
      await rename(claimedPath, movedPath);
      await mkdir(claimedPath, { mode: 0o700 });
      await writeFile(join(claimedPath, "foreign.txt"), "keep\n", "utf8");
    },
    temporaryRoot,
  });

  assert.deepEqual(cleanup, {
    preservedPaths: [claimedPath],
    removedPaths: [],
  });
  assert.equal(await readFile(join(claimedPath, "foreign.txt"), "utf8"), "keep\n");
  await access(forgedPath);
  await access(symlinkPath);
  await access(movedPath);
});

test("inspection-plan pointers reject traversal and symlinked files", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-pointer-");
  const snapshot = makeSnapshot();
  const created = await createDiffRun(snapshot, { temporaryRoot });
  const manifestPath = join(created.path, "run.json");
  const originalManifest = await readFile(manifestPath, "utf8");
  const traversing = JSON.parse(originalManifest);
  traversing.snapshotFile = "../snapshot.json";
  traversing.pagesFile = "../pages.json";
  await writeFile(manifestPath, `${JSON.stringify(traversing, null, 2)}\n`, "utf8");
  await assert.rejects(
    loadDiffRun(created.path, { temporaryRoot }),
    /plan pointers are unsafe/u,
  );

  await writeFile(manifestPath, originalManifest, "utf8");
  const snapshotPath = join(created.path, "snapshot.json");
  const snapshotTarget = join(created.path, "snapshot-target.json");
  await writeFile(snapshotTarget, await readFile(snapshotPath));
  await unlink(snapshotPath);
  await symlink(snapshotTarget, snapshotPath);
  await assert.rejects(
    loadDiffRun(created.path, { temporaryRoot }),
    /snapshot is not a regular file/u,
  );
});

test("a publication failure preserves its validated run for retry", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-publish-retry-");
  const { created } = await createAnalyzedRun(temporaryRoot);
  let removed = false;

  await assert.rejects(
    finishDiff(created.path, {
      finalize: async () => {
        throw new Error("publication failed");
      },
      removeRun: async () => {
        removed = true;
      },
      render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
      revalidate: async () => ({
        matches: true,
        revalidatedAt: "2026-07-23T00:01:00.000Z",
      }),
      temporaryRoot,
    }),
    (error) => {
      assert.equal(error.code, DIFF_PUBLICATION_RETRYABLE_CODE);
      assert.equal(error.canRetry, true);
      assert.equal(error.command, "finish");
      assert.equal(error.runPath, created.path);
      return true;
    },
  );
  assert.equal(removed, false);
  await access(created.path);

  const result = await finishDiff(created.path, {
    finalize: async () => ({ outputPath: join(temporaryRoot, "review.html") }),
    render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
    revalidate: async () => ({
      matches: true,
      revalidatedAt: "2026-07-23T00:01:00.000Z",
    }),
    temporaryRoot,
  });
  assert.equal(result.outputPath, join(temporaryRoot, "review.html"));
  await assert.rejects(access(created.path), /ENOENT/u);
});

test("a cleanup failure reports the review that was already published", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-cleanup-report-");
  const { created } = await createAnalyzedRun(temporaryRoot);
  const outputPath = join(temporaryRoot, "review.html");

  await assert.rejects(
    finishDiff(created.path, {
      finalize: async () => ({ outputPath }),
      removeRun: async () => {
        throw new Error("cleanup failed");
      },
      render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
      revalidate: async () => ({
        matches: true,
        revalidatedAt: "2026-07-23T00:01:00.000Z",
      }),
      temporaryRoot,
    }),
    (error) => {
      assert.equal(error.code, DIFF_CLEANUP_FAILED_CODE);
      assert.equal(error.outputPath, outputPath);
      assert.equal(error.runPath, created.path);
      assert.equal(error.cleanupPending, true);
      return true;
    },
  );
  await access(created.path);
  await removeDiffRun(created.path, { temporaryRoot });
});

test("a lock-release failure keeps the published review location", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-release-report-");
  const { created } = await createAnalyzedRun(temporaryRoot);
  const outputPath = join(temporaryRoot, "review.html");

  await assert.rejects(
    finishDiff(created.path, {
      claimMutation: async () => ({
        assertOwned: async () => {},
        release: async () => {
          throw new Error("lock release failed");
        },
      }),
      finalize: async () => ({ outputPath }),
      removeRun: async () => {
        throw new Error("cleanup failed");
      },
      render: async () => ({ bytes: Buffer.from("review"), digest: "d".repeat(64) }),
      revalidate: async () => ({
        matches: true,
        revalidatedAt: "2026-07-23T00:01:00.000Z",
      }),
      temporaryRoot,
    }),
    (error) => {
      assert.equal(error.code, DIFF_CLEANUP_FAILED_CODE);
      assert.equal(error.outputPath, outputPath);
      assert.equal(error.runPath, created.path);
      assert.equal(error.cleanupPending, true);
      return true;
    },
  );
  await removeDiffRun(created.path, { temporaryRoot });
});

test("inspection windows are ordered and replayable", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-window-order-");
  const created = await createDiffRun(makeSnapshot(), { temporaryRoot });
  await assert.rejects(
    inspectDiffRunWindow(created.path, 2, { temporaryRoot }),
    /window 1 next/u,
  );
  const first = await inspectDiffRunWindow(created.path, 1, { temporaryRoot });
  const replay = await inspectDiffRunWindow(created.path, 1, { temporaryRoot });
  assert.deepEqual(replay, first);
  await removeDiffRun(created.path, { temporaryRoot });
});

test("a canonical temporary-root alias can resume a DiffRun", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-canonical-");
  const aliasRoot = await createTestTemporaryDirectory("hope-run-alias-");
  const alias = join(aliasRoot, "alias");
  await symlink(temporaryRoot, alias, "dir");
  const created = await createDiffRun(makeSnapshot(), { temporaryRoot });
  const loaded = await loadDiffRun(
    created.path.replace(temporaryRoot, alias),
    { temporaryRoot: alias },
  );
  assert.equal(loaded.manifest.runId, created.runId);
});

test("UTF-8 and escaped inspection chunks reconstruct exact source text", () => {
  const snapshot = makeSnapshot();
  for (const text of [
    Array.from({ length: 2_000 }, (_, index) => (
      `${index + 1}: 모델 복원 상태를 확인합니다.`
    )).join("\n"),
    Array.from({ length: 200 }, (_, index) => (
      `${index + 1}: ${String.raw`"quoted\\path"`.repeat(8)}`
    )).join("\n"),
  ]) {
    const source = {
      ...snapshot.sources[2],
      lineCount: text.split("\n").length,
      text,
    };
    const pages = buildInspectionPages({
      ...snapshot,
      sources: [...snapshot.sources.slice(0, 2), source],
    });
    const reconstructed = pages
      .filter((page) => page.kind === "sources")
      .flatMap((page) => page.value.sources)
      .filter((item) => item.sourceId === source.id)
      .map((item) => item.text)
      .join("\n");
    assert.equal(reconstructed, text);
    for (const page of pages) {
      assert.ok(Buffer.byteLength(JSON.stringify(page)) <= LIMITS.inspectionPageBytes);
    }
  }
});

test("a prepared run reports content-free resource counters", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-resources-");
  const snapshot = makeSnapshot();
  const created = await createDiffRun(snapshot, { temporaryRoot });
  const pages = JSON.parse(await readFile(join(created.path, "pages.json"), "utf8"));
  const plannedInspectionBytes = pages.reduce(
    (sum, page) => sum + Buffer.byteLength(
      `${JSON.stringify(inspectionPageView(page))}\n`,
      "utf8",
    ),
    0,
  );

  assert.deepEqual(created.resources, {
    plannedInspectionBytes,
    plannedInspectionPages: created.pageCount,
    sourceBytes: snapshot.sources.reduce(
      (sum, source) => sum + Buffer.byteLength(source.text, "utf8"),
      0,
    ),
  });
  await removeDiffRun(created.path, { temporaryRoot });
});

test("tampered inspection pages fail closed", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-tamper-");
  const created = await createDiffRun(makeSnapshot(), { temporaryRoot });
  const pagesPath = join(created.path, "pages.json");
  const pages = JSON.parse(await readFile(pagesPath, "utf8"));
  pages[0].value.warning = "changed";
  await writeFile(pagesPath, `${JSON.stringify(pages, null, 2)}\n`, "utf8");
  await assert.rejects(
    inspectDiffRunWindow(created.path, 1, { temporaryRoot }),
    /inspection page plan is invalid/u,
  );
});

test("a stale snapshot creates no review artifact", async () => {
  const temporaryRoot = await createTestTemporaryDirectory("hope-run-stale-");
  const outputPath = join(temporaryRoot, "stale.html");
  const { created } = await createAnalyzedRun(temporaryRoot, { outputPath });

  await assert.rejects(
    finishDiff(created.path, {
      revalidate: async () => ({
        matches: false,
        revalidatedAt: "2026-07-23T00:01:00.000Z",
      }),
      temporaryRoot,
    }),
    /changed while Hope was reviewing/u,
  );
  await assert.rejects(access(outputPath), /ENOENT/u);
  await assert.rejects(loadDiffRun(created.path, { temporaryRoot }), /ENOENT/u);
});
