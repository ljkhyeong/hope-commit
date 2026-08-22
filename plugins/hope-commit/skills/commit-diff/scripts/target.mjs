import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 30_000;

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
} = {}, { exec = execFile } = {}) {
  if (typeof commit !== "string" || !/^[a-f0-9]{4,64}$/iu.test(commit)) {
    throw new TypeError("Hope Commit needs a hexadecimal commit ID");
  }
  if (!Number.isSafeInteger(parentNumber) || parentNumber < 1) {
    throw new TypeError("Hope Commit parent number must be a positive integer");
  }
  const requestedPath = resolve(repositoryPath);
  let root;
  let resolvedCommit;
  try {
    const [rootResult, commitResult] = await Promise.all([
      exec("git", ["-C", requestedPath, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: GIT_TIMEOUT_MS,
      }),
      exec("git", ["-C", requestedPath, "rev-parse", "--verify", `${commit}^{commit}`], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: GIT_TIMEOUT_MS,
      }),
    ]);
    root = rootResult.stdout.trim();
    resolvedCommit = commitResult.stdout.trim().toLowerCase();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Hope Commit requires Git", { cause: error });
    }
    throw new Error("Hope Commit could not resolve that commit in the selected repository", {
      cause: error,
    });
  }
  if (!root || !/^[a-f0-9]{40,64}$/u.test(resolvedCommit)) {
    throw new Error("Hope Commit could not resolve an immutable commit target");
  }
  return Object.freeze({
    commit: resolvedCommit,
    parentNumber,
    repositoryPath: resolve(root),
    selection: "explicit-commit",
  });
}
