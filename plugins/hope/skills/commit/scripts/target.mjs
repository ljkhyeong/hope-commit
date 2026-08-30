import { resolve } from "node:path";

import { resolveCommit, resolveRepositoryPath } from "./git.mjs";

export function parseCommitTargetArgument(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{4,64}$/iu.test(value)) {
    throw new TypeError("Hope Commit needs a hexadecimal commit ID");
  }
  return Object.freeze({ commit: value.toLowerCase() });
}

export async function resolveLocalCommitTarget({
  commit,
  parentNumber = 1,
  repositoryPath = process.cwd(),
} = {}, { exec, execInput } = {}) {
  if (!Number.isSafeInteger(parentNumber) || parentNumber < 1) {
    throw new TypeError("Hope Commit parent number must be a positive integer");
  }
  const requestedPath = resolve(repositoryPath);
  const options = { exec, execInput, maxBuffer: 64 * 1024 };
  const [root, resolvedCommit] = await Promise.all([
    resolveRepositoryPath(requestedPath, options),
    resolveCommit(requestedPath, commit, options),
  ]);
  return Object.freeze({
    commit: resolvedCommit,
    parentNumber,
    repositoryPath: root,
    selection: "explicit-commit",
  });
}
