import { resolve } from "node:path";

import { resolveRepositoryPath, runGit } from "./git.mjs";

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
} = {}, { exec } = {}) {
  if (typeof commit !== "string" || !/^[a-f0-9]{4,64}$/iu.test(commit)) {
    throw new TypeError("Hope Commit needs a hexadecimal commit ID");
  }
  if (!Number.isSafeInteger(parentNumber) || parentNumber < 1) {
    throw new TypeError("Hope Commit parent number must be a positive integer");
  }
  const requestedPath = resolve(repositoryPath);
  const options = { exec, maxBuffer: 64 * 1024 };
  const [root, commitResult] = await Promise.all([
    resolveRepositoryPath(requestedPath, options),
    runGit(requestedPath, ["rev-parse", "--verify", `${commit}^{commit}`], options),
  ]);
  const resolvedCommit = commitResult.trim().toLowerCase();
  if (!/^[a-f0-9]{40,64}$/u.test(resolvedCommit)) {
    throw new Error("Hope Commit could not resolve an immutable commit target");
  }
  return Object.freeze({
    commit: resolvedCommit,
    parentNumber,
    repositoryPath: root,
    selection: "explicit-commit",
  });
}
