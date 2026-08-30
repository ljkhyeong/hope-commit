import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { normalizeLineEndings } from "../tools/build-plugin.mjs";
import { pluginPackageFiles } from "../tools/plugin-files.mjs";
import { stagePlugin } from "../tools/stage-plugin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("the staged plugin runs from an external platform path", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "hope platform smoke-"));
  context.after(async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  });

  const destination = join(temporaryRoot, "installed plugin", "hope");
  const stagedFiles = await stagePlugin(destination);
  assert.deepEqual(
    stagedFiles,
    pluginPackageFiles.map((path) => path.replace(/^plugins\/hope\//u, "")),
  );

  const manifest = JSON.parse(await readFile(
    join(destination, ".codex-plugin", "plugin.json"),
    "utf8",
  ));
  assert.equal(manifest.name, "hope");
  assert.equal(manifest.skills, "./skills/");

  const sweepOpenAi = normalizeLineEndings(await readFile(
    join(destination, "skills", "sweep", "agents", "openai.yaml"),
    "utf8",
  ));
  assert.match(
    sweepOpenAi,
    /\npolicy:\n  allow_implicit_invocation: false\n/u,
  );

  const sweepSkill = normalizeLineEndings(await readFile(
    join(destination, "skills", "sweep", "SKILL.md"),
    "utf8",
  ));
  assert.match(sweepSkill, /description: Use only when someone explicitly invokes/u);
  assert.match(sweepSkill, /\$hope:sweep in Codex/u);
  assert.match(sweepSkill, /\/hope:sweep in Claude Code/u);
  assert.match(
    sweepSkill,
    /If an implicit selection reaches this Skill, stop before inspecting or editing/u,
  );
  assert.equal(
    stagedFiles.some((path) => path.startsWith("skills/polish/")),
    false,
  );

  const commitOpenAi = normalizeLineEndings(await readFile(
    join(destination, "skills", "commit", "agents", "openai.yaml"),
    "utf8",
  ));
  assert.match(
    commitOpenAi,
    /\npolicy:\n  allow_implicit_invocation: false\n/u,
  );

  const commitSkill = normalizeLineEndings(await readFile(
    join(destination, "skills", "commit", "SKILL.md"),
    "utf8",
  ));
  assert.match(commitSkill, /\$hope:commit/u);
  assert.match(commitSkill, /Do not infer consent from a commit ID/u);

  const outsideRepository = join(temporaryRoot, "outside repository");
  await mkdir(outsideRepository);

  for (const feature of ["diff", "commit"]) {
    const runModule = await import(pathToFileURL(join(
      destination,
      "skills",
      feature,
      "scripts",
      "run.mjs",
    )).href);
    const target = join(outsideRepository, `${feature}-new.json`);
    await runModule.writeNewJson(target, { feature, state: "처음 기록" });
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), {
      feature,
      state: "처음 기록",
    });
    await assert.rejects(
      runModule.writeNewJson(target, { feature, state: "덮어쓰기" }),
      (error) => error?.code === "EEXIST",
    );
  }
  const alignHelp = spawnSync(
    process.execPath,
    [join(destination, "skills", "align", "scripts", "cli.mjs"), "--help"],
    {
      cwd: outsideRepository,
      encoding: "utf8",
    },
  );
  assert.equal(alignHelp.status, 0, alignHelp.stderr);
  assert.match(alignHelp.stdout, /Use Hope Align through its private Skill adapter/u);
  assert.doesNotMatch(alignHelp.stderr, /\S/u);

  const diffHelp = spawnSync(
    process.execPath,
    [join(destination, "skills", "diff", "scripts", "cli.mjs"), "--help"],
    {
      cwd: outsideRepository,
      encoding: "utf8",
    },
  );
  assert.equal(diffHelp.status, 0, diffHelp.stderr);
  assert.match(diffHelp.stdout, /Use Hope Diff through its private Skill adapter/u);
  assert.doesNotMatch(diffHelp.stderr, /\S/u);

  const commitHelp = spawnSync(
    process.execPath,
    [join(destination, "skills", "commit", "scripts", "cli.mjs"), "--help"],
    {
      cwd: outsideRepository,
      encoding: "utf8",
    },
  );
  assert.equal(commitHelp.status, 0, commitHelp.stderr);
  assert.match(commitHelp.stdout, /Use Hope Commit through its private Skill adapter/u);
  assert.doesNotMatch(commitHelp.stderr, /\S/u);

  assert.notEqual(resolve(destination), resolve(root, "plugins", "hope"));
});
