import { isUtf8 } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import { CONTRACT_VERSION, LIMITS } from "./constants.mjs";
import { digestJson } from "./hash.mjs";
import { redactionKind } from "./redact.mjs";
import { exposeBidiControls } from "./text.mjs";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

function byteLength(value) {
  return Buffer.byteLength(value ?? "", "utf8");
}

function cleanText(value) {
  return exposeBidiControls(String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "\uFFFD"));
}

function validateObjectId(value, label = "commit") {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/iu.test(value)) {
    throw new Error(`Hope Commit needs an immutable ${label} object id`);
  }
  return value.toLowerCase();
}

function validateRepositoryPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Hope Commit needs a repository path");
  }
  return resolve(value);
}

function validateGitPath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Hope Commit found an unsafe repository-relative path");
  }
  return value;
}

async function runGit(repositoryPath, arguments_, {
  encoding = "utf8",
  exec = execFile,
  maxBuffer = GIT_MAX_BUFFER,
  timeout = GIT_TIMEOUT_MS,
} = {}) {
  try {
    const { stdout } = await exec(
      "git",
      ["-C", repositoryPath, "--literal-pathspecs", ...arguments_],
      { encoding, maxBuffer, timeout },
    );
    return stdout;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Hope Commit requires Git", { cause: error });
    }
    const detail = String(error?.stderr ?? "").trim();
    throw new Error(
      detail ? `Git failed: ${detail}` : "Git failed while collecting the commit",
      { cause: error },
    );
  }
}

async function tryGit(repositoryPath, arguments_, options = {}) {
  try {
    return await runGit(repositoryPath, arguments_, options);
  } catch {
    return undefined;
  }
}

async function resolveRepositoryPath(value, options = {}) {
  const requested = validateRepositoryPath(value ?? process.cwd());
  const root = cleanText(await runGit(
    requested,
    ["rev-parse", "--show-toplevel"],
    options,
  )).trim();
  if (!root) throw new Error("Hope Commit could not resolve the repository root");
  return resolve(root);
}

async function resolveCommit(repositoryPath, value, options = {}) {
  if (typeof value !== "string" || !/^[a-f0-9]{4,64}$/iu.test(value)) {
    throw new TypeError("Hope Commit needs a hexadecimal commit ID");
  }
  const resolved = cleanText(await runGit(
    repositoryPath,
    ["rev-parse", "--verify", `${value}^{commit}`],
    options,
  )).trim();
  return validateObjectId(resolved);
}

async function emptyTree(repositoryPath, options = {}) {
  const objectFormat = cleanText(await runGit(
    repositoryPath,
    ["rev-parse", "--show-object-format"],
    options,
  )).trim();
  if (objectFormat === "sha1") return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
  const value = cleanText(await runGit(
    repositoryPath,
    ["hash-object", "-t", "tree", "/dev/null"],
    options,
  )).trim();
  return validateObjectId(value, "empty tree");
}

async function resolveParent(repositoryPath, commit, parentNumber, options = {}) {
  if (!Number.isSafeInteger(parentNumber) || parentNumber < 1) {
    throw new TypeError("Hope Commit parent number must be a positive integer");
  }
  const line = cleanText(await runGit(
    repositoryPath,
    ["rev-list", "--parents", "-n", "1", commit],
    options,
  )).trim();
  const [, ...parents] = line.split(/\s+/u);
  if (parents.length === 0) {
    if (parentNumber !== 1) {
      throw new Error("A root commit only supports parent 1 (the empty tree)");
    }
    return Object.freeze({ parent: await emptyTree(repositoryPath, options), parentCount: 0 });
  }
  if (parentNumber > parents.length) {
    throw new Error(`Commit has ${parents.length} parent(s); parent ${parentNumber} is unavailable`);
  }
  return Object.freeze({
    parent: validateObjectId(parents[parentNumber - 1], "parent"),
    parentCount: parents.length,
  });
}

function parseNameStatus(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("Hope Commit needs byte-safe Git path output");
  }
  const tokens = [];
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(0, start);
    if (end === -1) {
      throw new Error("Git returned malformed NUL-delimited paths");
    }
    const token = buffer.subarray(start, end);
    if (!isUtf8(token)) {
      throw new Error("Hope Commit does not support non-UTF-8 Git paths");
    }
    tokens.push(token.toString("utf8"));
    start = end + 1;
  }
  const files = [];
  for (let index = 0; index < tokens.length;) {
    const rawStatus = tokens[index++];
    const code = rawStatus[0];
    const previousPath = code === "R" || code === "C"
      ? validateGitPath(tokens[index++])
      : undefined;
    const path = validateGitPath(tokens[index++]);
    const providerStatus = {
      A: "added",
      C: "copied",
      D: "removed",
      M: "modified",
      R: "renamed",
      T: "changed",
      U: "changed",
      X: "changed",
    }[code] ?? "changed";
    files.push(Object.freeze({ path, previousPath, providerStatus }));
  }
  return files;
}

async function readBlob(repositoryPath, revision, path, options = {}) {
  if (!path) return Object.freeze({ state: "absent" });
  const object = `${validateObjectId(revision)}:${validateGitPath(path)}`;
  const type = cleanText(await tryGit(
    repositoryPath,
    ["cat-file", "-t", object],
    options,
  ) ?? "").trim();
  if (!type) return Object.freeze({ state: "absent" });
  if (type !== "blob") {
    return Object.freeze({
      reason: `Git reported a ${type} entry instead of a file blob`,
      reasonKind: "special-entry",
      state: "special",
    });
  }
  const sizeText = cleanText(await runGit(
    repositoryPath,
    ["cat-file", "-s", object],
    options,
  )).trim();
  const size = Number.parseInt(sizeText, 10);
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Git returned an invalid blob size for ${path}`);
  }
  if (size > LIMITS.safeBodyBytes) {
    return Object.freeze({
      reason: `The file exceeds Hope Commit's ${LIMITS.safeBodyBytes}-byte safe-text limit`,
      reasonKind: "safe-size-limit",
      state: "oversized",
    });
  }
  const bytes = await runGit(
    repositoryPath,
    ["cat-file", "blob", object],
    { ...options, encoding: null },
  );
  if (!Buffer.isBuffer(bytes) || bytes.length !== size) {
    throw new Error(`Git returned a partial blob for ${path}`);
  }
  if (!isUtf8(bytes)) {
    return Object.freeze({
      reason: "The file is not UTF-8 text",
      reasonKind: "invalid-text",
      state: "binary",
    });
  }
  return Object.freeze({ state: "text", text: cleanText(bytes.toString("utf8")) });
}

async function lineCounts(repositoryPath, parent, commit, paths, options = {}) {
  const output = cleanText(await runGit(
    repositoryPath,
    ["diff", "--numstat", "--find-renames", parent, commit, "--", ...paths],
    options,
  )).trim();
  if (!output) return Object.freeze({ additions: 0, deletions: 0 });
  const [added, deleted] = output.split("\t", 2);
  return Object.freeze({
    additions: /^\d+$/u.test(added) ? Number.parseInt(added, 10) : 0,
    deletions: /^\d+$/u.test(deleted) ? Number.parseInt(deleted, 10) : 0,
  });
}

function source(id, kind, text, extra = {}) {
  return Object.freeze({
    id,
    kind,
    lineCount: text.split("\n").length,
    text,
    ...extra,
  });
}

function addSource(sources, kind, text, extra = {}) {
  if (text === undefined || text === null) return undefined;
  const value = source(
    `source-${sources.length + 1}`,
    kind,
    cleanText(text),
    extra,
  );
  sources.push(value);
  return value.id;
}

function parseGitHubRemote(value) {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const match = value.trim().match(
    /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u,
  );
  if (!match) return undefined;
  return Object.freeze({
    name: match[2],
    owner: match[1],
    webUrl: `https://github.com/${match[1]}/${match[2]}`,
  });
}

function unavailableReason(kind) {
  return {
    "credential-pattern": "The file body matched a high-confidence credential pattern",
    "invalid-text": "The file is not UTF-8 text",
    "private-path": "The file name commonly contains private configuration",
    "safe-size-limit": `The file exceeds Hope Commit's ${LIMITS.safeBodyBytes}-byte safe-text limit`,
    "special-entry": "Git reported a special repository entry",
  }[kind] ?? "The file body is unavailable";
}

export async function collectLocalGitCommit(target, {
  clock = () => new Date(),
  exec,
  locale,
  localeSource,
  theme,
  themeSource,
} = {}) {
  const options = exec ? { exec } : {};
  const repositoryPath = await resolveRepositoryPath(target.repositoryPath, options);
  const commit = await resolveCommit(repositoryPath, target.commit, options);
  const parentNumber = target.parentNumber ?? 1;
  const { parent, parentCount } = await resolveParent(
    repositoryPath,
    commit,
    parentNumber,
    options,
  );
  const [subjectValue, bodyValue, authorValue, authoredAtValue, remoteValue] = await Promise.all([
    runGit(repositoryPath, ["show", "-s", "--format=%s", commit], options),
    runGit(repositoryPath, ["show", "-s", "--format=%b", commit], options),
    runGit(repositoryPath, ["show", "-s", "--format=%an", commit], options),
    runGit(repositoryPath, ["show", "-s", "--format=%aI", commit], options),
    tryGit(repositoryPath, ["config", "--get", "remote.origin.url"], options),
  ]);
  const subject = cleanText(subjectValue).trim();
  const body = cleanText(bodyValue).trim();
  const author = cleanText(authorValue).trim();
  const authoredAt = cleanText(authoredAtValue).trim();
  const remote = parseGitHubRemote(remoteValue);
  if (redactionKind("commit-metadata.txt", [subject, body]) === "credential-pattern") {
    throw new Error("Commit metadata contains a suspected credential; no review was created");
  }

  const rawStatus = await runGit(
    repositoryPath,
    ["diff", "--name-status", "-z", "--find-renames", parent, commit],
    { ...options, encoding: null },
  );
  const changed = parseNameStatus(rawStatus);
  if (changed.length > LIMITS.changedFiles) {
    throw new Error(`Commit has ${changed.length} files; Hope Commit supports ${LIMITS.changedFiles}`);
  }

  const sources = [];
  addSource(sources, "pull-request-title", subject);
  addSource(sources, "pull-request-description", body);
  addSource(sources, "commit-title", subject, { revision: commit });
  const limits = [
    {
      id: "limit-1",
      kind: "unchanged-context",
      reason: "Only exact-revision context files explicitly requested after initial inspection are collected",
      subject: "Other unchanged code outside collected context",
    },
    {
      id: "limit-2",
      kind: "verification",
      reason: "Hope Commit does not collect or execute CI, tests, builds, or lint",
      subject: "Execution and CI results",
    },
  ];
  let totalBodyBytes = 0;
  let totalChangedLines = 0;
  const files = [];

  for (const [index, changedFile] of changed.entries()) {
    const id = `file-${index + 1}`;
    const beforePath = changedFile.previousPath ?? changedFile.path;
    const [counts, before, after] = await Promise.all([
      lineCounts(
        repositoryPath,
        parent,
        commit,
        [changedFile.previousPath, changedFile.path].filter(Boolean),
        options,
      ),
      changedFile.providerStatus === "added"
        ? { state: "absent" }
        : readBlob(repositoryPath, parent, beforePath, options),
      changedFile.providerStatus === "removed"
        ? { state: "absent" }
        : readBlob(repositoryPath, commit, changedFile.path, options),
    ]);
    totalChangedLines += counts.additions + counts.deletions;
    const texts = [before.text, after.text].filter(Boolean);
    const redaction = redactionKind(changedFile.path, texts)
      ?? redactionKind(beforePath, texts);
    const unavailable = [before, after].find((item) => (
      item.state === "binary"
      || item.state === "oversized"
      || item.state === "special"
    ));
    const bodyBytes = texts.reduce((sum, text) => sum + byteLength(text), 0);
    totalBodyBytes += bodyBytes;
    if (totalBodyBytes > LIMITS.safeBodyTotalBytes) {
      throw new Error(
        `Safe changed-file text exceeds Hope Commit's ${LIMITS.safeBodyTotalBytes}-byte limit`,
      );
    }
    const bodyState = redaction
      ? "redacted"
      : unavailable
        ? "metadata-only"
        : "included";
    const sourceIds = [];
    if (bodyState === "included") {
      const patch = cleanText(await runGit(
        repositoryPath,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--find-renames",
          "--unified=80",
          parent,
          commit,
          "--",
          ...[changedFile.previousPath, changedFile.path].filter(Boolean),
        ],
        options,
      ));
      if (patch) {
        sourceIds.push(addSource(sources, "patch", patch, {
          fileId: id,
          path: changedFile.path,
          revision: commit,
        }));
      }
    } else {
      const reasonKind = redaction ?? unavailable?.reasonKind ?? "special-entry";
      limits.push({
        id: `limit-${limits.length + 1}`,
        kind: "file-unavailable",
        reason: unavailable?.reason ?? unavailableReason(reasonKind),
        reasonKind,
        subject: changedFile.path,
      });
    }
    files.push(Object.freeze({
      additions: counts.additions,
      bodyReason: bodyState === "included" ? undefined : limits.at(-1)?.reason,
      bodyReasonKind: bodyState === "included" ? undefined : limits.at(-1)?.reasonKind,
      bodyState,
      deletions: counts.deletions,
      id,
      path: changedFile.path,
      previousPath: changedFile.previousPath,
      providerStatus: changedFile.providerStatus,
      sourceIds: sourceIds.filter(Boolean),
    }));
  }
  if (totalChangedLines > LIMITS.changedLines) {
    throw new Error(
      `Commit has ${totalChangedLines} changed lines; Hope Commit supports ${LIMITS.changedLines}`,
    );
  }

  const repositoryName = remote?.name ?? basename(repositoryPath);
  const repositoryOwner = remote?.owner ?? "local";
  const commitUrl = remote ? `${remote.webUrl}/commit/${commit}` : undefined;
  const capturedAt = clock().toISOString();
  const snapshot = {
    schemaVersion: CONTRACT_VERSION,
    capturedAt,
    commit: {
      author,
      authoredAt,
      body,
      id: commit,
      parent,
      parentCount,
      parentNumber,
      subject,
      url: commitUrl,
    },
    files,
    limits,
    // Keep the original Hope analysis contract internally while the renderer migrates to `commit`.
    pullRequest: {
      author,
      number: 0,
      state: "immutable",
      title: subject,
      url: commitUrl,
    },
    repository: {
      base: { name: repositoryName, owner: repositoryOwner },
      head: { name: repositoryName, owner: repositoryOwner },
      name: repositoryName,
      owner: repositoryOwner,
      path: repositoryPath,
      provider: remote ? "github" : "local-git",
      webUrl: remote?.webUrl,
    },
    settings: {
      locale,
      localeSource,
      theme,
      themeSource,
    },
    snapshot: {
      base: parent,
      head: commit,
      mergeBase: parent,
    },
    sources,
  };
  return Object.freeze({ ...snapshot, digest: digestJson(snapshot) });
}

export async function revalidateLocalGitSnapshot(collected, {
  clock = () => new Date(),
  exec,
} = {}) {
  const repositoryPath = validateRepositoryPath(collected?.repository?.path);
  const options = exec ? { exec } : {};
  const expectedHead = validateObjectId(collected?.snapshot?.head, "head");
  const expectedBase = validateObjectId(collected?.snapshot?.base, "base");
  const [head, base] = await Promise.all([
    tryGit(repositoryPath, ["rev-parse", "--verify", `${expectedHead}^{commit}`], options),
    tryGit(repositoryPath, ["cat-file", "-e", expectedBase], options),
  ]);
  const currentHead = cleanText(head ?? "").trim().toLowerCase();
  const matches = currentHead === expectedHead && base !== undefined;
  return Object.freeze({
    current: {
      base: matches ? expectedBase : undefined,
      head: currentHead || undefined,
      mergeBase: matches ? expectedBase : undefined,
    },
    matches,
    revalidatedAt: clock().toISOString(),
  });
}

export { readBlob as readGitBlob, unavailableReason as gitUnavailableReason };
