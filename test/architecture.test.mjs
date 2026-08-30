import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginRoot = resolve(root, "plugins/hope");
const skillsRoot = resolve(pluginRoot, "skills");
const reviewCoreRoot = resolve(pluginRoot, "review-core");
const sharedAssetsRoot = resolve(pluginRoot, "assets");
const sharedWritingStandard = resolve(
  skillsRoot,
  "write/references/writing-standard.md",
);
const sharedCodeMaintenanceGuidance = resolve(
  pluginRoot,
  "references/code-maintenance.md",
);
const publishedSharedGuidance = new Set([
  sharedCodeMaintenanceGuidance,
  sharedWritingStandard,
]);
const deliveryDependencyPattern =
  /(?:CLAUDE_)?PLUGIN_ROOT|plugins\/hope(?:-commit)?|\.codex-plugin|\.claude-plugin|marketplace/u;

async function exists(path) {
  return await access(path).then(() => true, () => false);
}

function isInside(directory, path) {
  const fromDirectory = relative(directory, path);
  return fromDirectory === ""
    || (!isAbsolute(fromDirectory)
      && fromDirectory !== ".."
      && !fromDirectory.startsWith(`..${sep}`));
}

async function collectFiles(directory, suffix) {
  if (!await exists(directory)) return [];
  const pending = [directory];
  const files = [];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
    }
  }
  return files.sort();
}

async function discoverFeatures() {
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      root: resolve(skillsRoot, entry.name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function capturedValues(source, patterns) {
  const values = new Set();
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) values.add(match[1]);
  }
  return [...values];
}

function moduleSpecifiers(source) {
  return capturedValues(source, [
    /\b(?:import|export)\s+(?:[^"'();]+?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\(\s*["']([^"']+)["']\s*(?:,|\))/gu,
  ]);
}

function staticImportMetaResources(source) {
  return [
    ...source.matchAll(
      /\bnew URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/gu,
    ),
    ...source.matchAll(
      /\bnew URL\(\s*`((?:(?!\$\{)[^`])*)`\s*,\s*import\.meta\.url\s*\)/gu,
    ),
  ].map((match) => match[1]);
}

function approvedScriptDependency(featureName, featureRoot, dependency) {
  return isInside(featureRoot, dependency)
    || (["commit", "diff"].includes(featureName)
      && isInside(reviewCoreRoot, dependency));
}

function scriptBoundaryIssues(source, path, feature) {
  const issues = [];
  if (deliveryDependencyPattern.test(source)) {
    issues.push("depends on delivery packaging");
  }

  for (const specifier of moduleSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;
    const dependency = resolve(dirname(path), specifier);
    if (!approvedScriptDependency(feature.name, feature.root, dependency)) {
      issues.push(`imports outside its approved boundary: ${specifier}`);
    }
  }

  for (const resource of staticImportMetaResources(source)) {
    if (!resource.startsWith(".")) continue;
    const dependency = resolve(dirname(path), resource);
    if (
      !approvedScriptDependency(feature.name, feature.root, dependency)
      && !isInside(sharedAssetsRoot, dependency)
    ) {
      issues.push(`reads a resource outside its approved boundary: ${resource}`);
    }
  }

  return issues;
}

function documentPathReferences(source) {
  return capturedValues(source, [
    /`((?:\.\.\/)+[^`\s]+)`/gu,
    /\]\(((?:\.\.\/)+[^)\s]+)\)/gu,
  ]);
}

function guidanceBoundaryIssues(source, path, featureRoot) {
  const issues = [];
  if (
    isInside(resolve(featureRoot, "references"), path)
    && deliveryDependencyPattern.test(source)
  ) {
    issues.push("reference depends on delivery packaging");
  }

  for (const reference of documentPathReferences(source)) {
    const dependency = resolve(dirname(path), reference.split("#", 1)[0]);
    if (
      !isInside(featureRoot, dependency)
      && !publishedSharedGuidance.has(dependency)
    ) {
      issues.push(
        `references guidance outside its Skill without a published shared contract: ${reference}`,
      );
    }
  }

  return issues;
}

test("every discovered feature has one editable Skill boundary", async () => {
  for (const path of ["features", "design", "harness", "settings"]) {
    assert.equal(await exists(resolve(root, path)), false);
  }
  assert.equal(await exists(resolve(pluginRoot, "runtime")), false);

  const features = await discoverFeatures();
  assert.ok(features.length > 0, "Hope must contain at least one feature");
  for (const feature of features) {
    assert.equal(
      await exists(resolve(feature.root, "SKILL.md")),
      true,
      `${feature.name} must own one SKILL.md`,
    );
  }
});

test("feature script dependencies stay within their approved boundaries", async () => {
  const issues = [];
  for (const feature of await discoverFeatures()) {
    const scripts = await collectFiles(resolve(feature.root, "scripts"), ".mjs");
    for (const path of scripts) {
      const source = await readFile(path, "utf8");
      for (const issue of scriptBoundaryIssues(source, path, feature)) {
        issues.push(`${relative(root, path)} ${issue}`);
      }
    }
  }
  assert.deepEqual(issues, []);
});

test("the review core contains only approved shared invariants", async () => {
  const entries = await readdir(reviewCoreRoot, { withFileTypes: true });
  assert.deepEqual(
    entries.map((entry) => entry.name).sort(),
    [
      "derive.mjs",
      "evidence-range.mjs",
      "hash.mjs",
      "redact.mjs",
      "structured-input.mjs",
      "text.mjs",
    ],
  );
  const issues = [];
  for (const entry of entries) {
    assert.equal(entry.isFile(), true);
    const path = resolve(reviewCoreRoot, entry.name);
    const source = await readFile(path, "utf8");
    if (/skills\/|runtime|renderer|publication/u.test(source)) {
      issues.push(`${relative(root, path)} contains feature-owned behavior`);
    }
    for (const specifier of moduleSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      if (!isInside(reviewCoreRoot, resolve(dirname(path), specifier))) {
        issues.push(`${relative(root, path)} imports outside the review core: ${specifier}`);
      }
    }
    for (const resource of staticImportMetaResources(source)) {
      if (!resource.startsWith(".")) continue;
      if (!isInside(reviewCoreRoot, resolve(dirname(path), resource))) {
        issues.push(`${relative(root, path)} reads outside the review core: ${resource}`);
      }
    }
  }
  assert.deepEqual(issues, []);
});

test("feature documents use only published cross-feature guidance", async () => {
  for (const guidance of publishedSharedGuidance) {
    assert.equal(await exists(guidance), true);
  }
  const issues = [];
  for (const feature of await discoverFeatures()) {
    const documents = [
      resolve(feature.root, "SKILL.md"),
      ...await collectFiles(resolve(feature.root, "references"), ".md"),
    ];
    for (const path of documents) {
      const source = await readFile(path, "utf8");
      for (const issue of guidanceBoundaryIssues(source, path, feature.root)) {
        issues.push(`${relative(root, path)} ${issue}`);
      }
    }
  }
  assert.deepEqual(issues, []);
});

test("architecture checks distinguish approved and forbidden source edges", () => {
  const feature = {
    name: "commit",
    root: resolve(skillsRoot, "commit"),
  };
  const script = resolve(feature.root, "scripts/main.mjs");
  assert.deepEqual(
    moduleSpecifiers(
      'const data = await import("../../other/data.json", { with: { type: "json" } });',
    ),
    ["../../other/data.json"],
  );
  assert.deepEqual(
    staticImportMetaResources(
      "const manifest = new URL(`../../../.codex-plugin/plugin.json`, import.meta.url);",
    ),
    ["../../../.codex-plugin/plugin.json"],
  );
  assert.deepEqual(
    scriptBoundaryIssues(
      'import { digestJson } from "../../../review-core/hash.mjs";',
      script,
      feature,
    ),
    [],
  );
  assert.deepEqual(
    scriptBoundaryIssues(
      'const icon = new URL("../../../assets/hope-icon.png", import.meta.url);',
      script,
      feature,
    ),
    [],
  );
  assert.ok(scriptBoundaryIssues(
    'import "../../diff/scripts/index.mjs";',
    script,
    feature,
  ).some((issue) => issue.includes("outside its approved boundary")));
  assert.ok(scriptBoundaryIssues(
    'const manifest = new URL("../../../.codex-plugin/plugin.json", import.meta.url);',
    script,
    feature,
  ).some((issue) => issue.includes("outside its approved boundary")));

  const skill = resolve(feature.root, "SKILL.md");
  assert.deepEqual(
    guidanceBoundaryIssues(
      "Read `../write/references/writing-standard.md`.",
      skill,
      feature.root,
    ),
    [],
  );
  assert.ok(guidanceBoundaryIssues(
    "Read `../diff/references/analysis.md`.",
    skill,
    feature.root,
  ).some((issue) => issue.includes("without a published shared contract")));
});
