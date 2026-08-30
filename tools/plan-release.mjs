#!/usr/bin/env node

import { appendFile } from "node:fs/promises";

import { isEntrypoint } from "./entrypoint.mjs";
import { parseStableVersion } from "./release-impact.mjs";

const releaseEvents = new Set(["workflow_dispatch", "workflow_run"]);

function stableVersion(value, name) {
  try {
    parseStableVersion(value);
  } catch {
    throw new Error(`${name} '${value}'은 안정 버전 형식이 아닙니다.`);
  }
  return value;
}

function environmentBoolean(value, name) {
  if (value !== "true" && value !== "false") {
    throw new Error(`${name}은 true 또는 false여야 합니다.`);
  }
  return value === "true";
}

export function chooseReleasePlan({
  currentVersion,
  eventName,
  previousVersion = "",
  releaseState,
  tagExists,
}) {
  const version = stableVersion(currentVersion, "현재 버전");
  if (!releaseEvents.has(eventName)) {
    throw new Error(`지원하지 않는 릴리스 이벤트입니다: ${eventName}`);
  }
  if (previousVersion) stableVersion(previousVersion, "직전 버전");
  if (!["missing", "draft", "published"].includes(releaseState)) {
    throw new Error("RELEASE_STATE는 missing, draft, published 중 하나여야 합니다.");
  }
  if (releaseState === "draft") {
    throw new Error(
      `v${version} 미완료 릴리스 초안이 남아 있습니다. `
      + "초안을 확인하고 docs/release.md의 복구 절차를 따른 뒤 main에서 수동 릴리스를 실행하세요. "
      + "이 실행은 초안을 삭제하거나 공개하지 않습니다.",
    );
  }
  if (releaseState === "published" && !tagExists) {
    throw new Error(`v${version} GitHub Release에 대응하는 Git 태그가 없습니다.`);
  }
  if (tagExists) {
    return Object.freeze({
      currentTag: `v${version}`,
      currentVersion: version,
      mode: releaseState === "published" ? "none" : "resume",
      publish: releaseState !== "published",
    });
  }
  if (eventName === "workflow_run" && previousVersion === version) {
    throw new Error(
      `v${version} 태그가 없지만 검증된 커밋은 버전을 변경하지 않았습니다. `
      + "누락된 버전 변경이나 중단된 릴리스를 확인한 뒤 main에서 수동 릴리스를 실행하세요.",
    );
  }
  return Object.freeze({
    currentTag: `v${version}`,
    currentVersion: version,
    mode: "recorded",
    publish: true,
  });
}

function outputLines(plan) {
  return [
    `current-version=${plan.currentVersion}`,
    `current-tag=${plan.currentTag}`,
    `mode=${plan.mode}`,
    `publish=${plan.publish}`,
    "",
  ].join("\n");
}

async function main(environment = process.env) {
  if (!environment.GITHUB_OUTPUT) {
    throw new Error("GITHUB_OUTPUT 경로가 없습니다.");
  }
  const plan = chooseReleasePlan({
    currentVersion: environment.CURRENT_VERSION,
    eventName: environment.EVENT_NAME,
    previousVersion: environment.PREVIOUS_VERSION,
    releaseState: environment.RELEASE_STATE,
    tagExists: environmentBoolean(environment.TAG_EXISTS, "TAG_EXISTS"),
  });
  await appendFile(environment.GITHUB_OUTPUT, outputLines(plan), "utf8");
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
