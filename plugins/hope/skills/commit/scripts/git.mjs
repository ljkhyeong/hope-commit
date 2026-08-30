import { isUtf8 } from "node:buffer";
import { execFile as execFileCallback } from "node:child_process";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import { CONTRACT_VERSION, LIMITS } from "./constants.mjs";
import { digestJson } from "../../../review-core/hash.mjs";
import { redactionKind } from "../../../review-core/redact.mjs";
import { exposeBidiControls } from "../../../review-core/text.mjs";

const execFile = promisify(execFileCallback);
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const GIT_BATCH_BODY_BYTES = 4 * 1024 * 1024;
const GIT_DIFF_OPTIONS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--find-renames",
  "--ignore-submodules=none",
];
const GIT_REPOSITORY_ENV = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GLOB_PATHSPECS",
  "GIT_GRAFT_FILE",
  "GIT_ICASE_PATHSPECS",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_LITERAL_PATHSPECS",
  "GIT_NAMESPACE",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

function execFileWithInput(command, arguments_, options, input) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFileCallback(
      command,
      arguments_,
      options,
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          rejectPromise(error);
          return;
        }
        resolvePromise({ stderr, stdout });
      },
    );
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

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

function exactFilePathspec(path) {
  // 마지막 문자도 이스케이프해 같은 이름의 디렉터리 아래까지 선택되는 것을 막는다.
  return `:(top,glob)${path.replace(/[*?[\\\]]|.$/gu, "\\$&")}`;
}

export async function runGit(repositoryPath, arguments_, {
  encoding = "utf8",
  exec = execFile,
  execInput = execFileWithInput,
  input,
  maxBuffer = GIT_MAX_BUFFER,
  timeout = GIT_TIMEOUT_MS,
} = {}) {
  try {
    const commandArguments = [
      "--no-replace-objects",
      "--no-lazy-fetch",
      "-C",
      repositoryPath,
      "--literal-pathspecs",
      ...arguments_,
    ];
    const commandOptions = {
      encoding,
      env: Object.fromEntries(Object.entries(process.env).filter(
        ([key]) => !GIT_REPOSITORY_ENV.has(key.toUpperCase()),
      )),
      maxBuffer,
      timeout,
    };
    const { stdout } = input === undefined
      ? await exec("git", commandArguments, commandOptions)
      : await execInput("git", commandArguments, commandOptions, input);
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

async function readObjectTypes(repositoryPath, objects, options = {}) {
  const output = await runGit(repositoryPath, ["cat-file", "--batch-check=%(objecttype)"], {
    ...options,
    input: Buffer.from(`${objects.join("\n")}\n`),
  });
  const lines = output.trimEnd().split("\n");
  if (lines.length !== objects.length) {
    throw new Error("Git 객체 조회 응답 수가 요청과 다릅니다.");
  }
  return lines.map((line, index) => {
    if (line === `${objects[index]} missing`) return undefined;
    if (!["blob", "tree", "commit", "tag"].includes(line)) {
      throw new Error("Git 객체 조회 응답을 해석할 수 없습니다.");
    }
    return line;
  });
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
  const rawCommit = await runGit(
    repositoryPath,
    ["cat-file", "commit", commit],
    options,
  );
  const parents = rawCommit.split("\n\n", 1)[0].split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => validateObjectId(line.slice(7), "parent"));
  if (parents.length === 0) {
    if (parentNumber !== 1) {
      throw new Error("A root commit only supports parent 1 (the empty tree)");
    }
    return Object.freeze({ parent: await emptyTree(repositoryPath, options), parentCount: 0 });
  }
  if (parentNumber > parents.length) {
    throw new Error(`Commit has ${parents.length} parent(s); parent ${parentNumber} is unavailable`);
  }
  const parent = parents[parentNumber - 1];
  const [parentType] = await readObjectTypes(repositoryPath, [parent], options);
  if (parentType !== "commit") {
    throw new Error(
      `선택한 부모 커밋 ${parent}을 로컬에서 찾을 수 없습니다. `
      + "얕은 복제라면 Git 이력을 더 받은 뒤 다시 실행하세요.",
    );
  }
  return Object.freeze({
    parent,
    parentCount: parents.length,
  });
}

function nulDelimitedUtf8(buffer, label) {
  if (!Buffer.isBuffer(buffer)) {
    throw new TypeError("Hope Commit needs byte-safe Git path output");
  }
  const tokens = [];
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(0, start);
    if (end === -1) {
      throw new Error(`Git returned malformed NUL-delimited ${label}`);
    }
    const token = buffer.subarray(start, end);
    if (!isUtf8(token)) {
      throw new Error("Hope Commit does not support non-UTF-8 Git paths");
    }
    tokens.push(token.toString("utf8"));
    start = end + 1;
  }
  return tokens;
}

function parseNameStatus(buffer) {
  const tokens = nulDelimitedUtf8(buffer, "paths");
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

function changedFileKey(path, previousPath) {
  return `${previousPath ?? ""}\u0000${path}`;
}

function parseLineCount(value) {
  if (value === "-") return 0;
  if (!/^\d+$/u.test(value)) {
    throw new Error("Git returned an invalid changed-line count");
  }
  const count = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count)) {
    throw new Error("Git returned an unsafe changed-line count");
  }
  return count;
}

function parseNumstat(buffer) {
  const tokens = nulDelimitedUtf8(buffer, "line counts");
  const counts = new Map();
  for (let index = 0; index < tokens.length;) {
    const fields = tokens[index++].split("\t");
    if (fields.length !== 3) {
      throw new Error("Git returned malformed changed-line counts");
    }
    const additions = parseLineCount(fields[0]);
    const deletions = parseLineCount(fields[1]);
    let previousPath;
    let path = fields[2];
    if (path === "") {
      previousPath = validateGitPath(tokens[index++]);
      path = validateGitPath(tokens[index++]);
    } else {
      path = validateGitPath(path);
    }
    const key = changedFileKey(path, previousPath);
    if (counts.has(key)) {
      throw new Error("Git returned duplicate changed-line counts");
    }
    counts.set(key, Object.freeze({
      additions,
      binary: fields[0] === "-",
      deletions,
    }));
  }
  return counts;
}

function parseTreeEntries(buffer) {
  const tokens = nulDelimitedUtf8(buffer, "tree entries");
  const entries = new Map();
  for (const token of tokens) {
    const separator = token.indexOf("\t");
    if (separator < 0) throw new Error("Git returned a malformed tree entry");
    const metadata = token.slice(0, separator);
    const path = validateGitPath(token.slice(separator + 1));
    const match = metadata.match(
      /^(\d{6}) ([a-z]+) ([a-f0-9]{40,64})\s+(-|\d+)$/iu,
    );
    if (!match) throw new Error(`Git returned invalid tree metadata for ${path}`);
    const size = match[4] === "-" ? undefined : Number.parseInt(match[4], 10);
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) {
      throw new Error(`Git returned an invalid blob size for ${path}`);
    }
    entries.set(path, Object.freeze({
      objectId: validateObjectId(match[3], "tree entry"),
      size,
      type: match[2],
    }));
  }
  return entries;
}

async function readTreeEntries(repositoryPath, revision, paths, options = {}) {
  const selected = [...new Set(paths.filter(Boolean).map(validateGitPath))];
  if (selected.length === 0) return new Map();
  const output = await runGit(
    repositoryPath,
    ["ls-tree", "-r", "-z", "-l", validateObjectId(revision), "--", ...selected],
    { ...options, encoding: null },
  );
  return parseTreeEntries(output);
}

function blobDescriptor(entries, path) {
  if (!path) return Object.freeze({ state: "absent" });
  const entry = entries.get(path);
  if (!entry) return Object.freeze({ state: "absent" });
  if (entry.type !== "blob") {
    return Object.freeze({
      reason: `Git reported a ${entry.type} entry instead of a file blob`,
      reasonKind: "special-entry",
      state: "special",
    });
  }
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(`Git returned an invalid blob size for ${path}`);
  }
  if (entry.size > LIMITS.safeBodyBytes) {
    return Object.freeze({
      reason: `The file exceeds Hope Commit's ${LIMITS.safeBodyBytes}-byte safe-text limit`,
      reasonKind: "safe-size-limit",
      state: "oversized",
    });
  }
  return Object.freeze({
    objectId: entry.objectId,
    size: entry.size,
    state: "pending",
  });
}

function decodeBlob(bytes) {
  if (!isUtf8(bytes) || bytes.includes(0)) {
    return Object.freeze({
      reason: "파일에 NUL 바이트가 있거나 올바른 UTF-8 텍스트가 아닙니다.",
      reasonKind: "invalid-text",
      state: "binary",
    });
  }
  return Object.freeze({ state: "text", text: cleanText(bytes.toString("utf8")) });
}

function parseBlobBatch(output, requested) {
  if (!Buffer.isBuffer(output)) {
    throw new TypeError("Hope Commit needs byte-safe Git blob output");
  }
  const blobs = new Map();
  let cursor = 0;
  for (const expected of requested) {
    const headerEnd = output.indexOf(10, cursor);
    if (headerEnd < 0) throw new Error("Git returned a partial blob batch header");
    const header = output.subarray(cursor, headerEnd).toString("ascii");
    const match = header.match(/^([a-f0-9]{40,64}) blob (\d+)$/u);
    if (!match) throw new Error("Git returned invalid blob batch metadata");
    const objectId = validateObjectId(match[1], "blob");
    const size = Number.parseInt(match[2], 10);
    if (objectId !== expected.objectId || size !== expected.size) {
      throw new Error("Git returned an unexpected blob batch entry");
    }
    const bodyStart = headerEnd + 1;
    const bodyEnd = bodyStart + size;
    if (bodyEnd >= output.length || output[bodyEnd] !== 10) {
      throw new Error("Git returned a partial blob batch body");
    }
    const bytes = output.subarray(bodyStart, bodyEnd);
    blobs.set(objectId, decodeBlob(bytes));
    cursor = bodyEnd + 1;
  }
  if (cursor !== output.length) {
    throw new Error("Git returned trailing blob batch data");
  }
  return blobs;
}

async function readBlobBatch(repositoryPath, descriptors, options = {}) {
  const pending = [...new Map(descriptors
    .filter((item) => item.state === "pending")
    .map((item) => [item.objectId, item])).values()];
  const blobs = new Map();
  for (let start = 0; start < pending.length;) {
    const requested = [];
    let requestedBytes = 0;
    while (start < pending.length) {
      const candidate = pending[start];
      if (
        requested.length > 0
        && requestedBytes + candidate.size > GIT_BATCH_BODY_BYTES
      ) break;
      requested.push(candidate);
      requestedBytes += candidate.size;
      start += 1;
    }
    const output = await runGit(
      repositoryPath,
      ["cat-file", "--batch"],
      {
        ...options,
        encoding: null,
        input: Buffer.from(`${requested.map((item) => item.objectId).join("\n")}\n`),
      },
    );
    for (const [objectId, value] of parseBlobBatch(output, requested)) {
      blobs.set(objectId, value);
    }
  }
  return descriptors.map((descriptor) => (
    descriptor.state === "pending" ? blobs.get(descriptor.objectId) : descriptor
  ));
}

async function readBlob(repositoryPath, revision, path, options = {}) {
  if (!path) return Object.freeze({ state: "absent" });
  const object = `${validateObjectId(revision)}:${validateGitPath(path)}`;
  const [type] = await readObjectTypes(repositoryPath, [object], options);
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
  return decodeBlob(bytes);
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
  execInput,
  locale,
  localeSource,
  theme,
  themeSource,
} = {}) {
  const options = {
    ...(exec ? { exec } : {}),
    ...(execInput ? { execInput } : {}),
  };
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
    ["diff", ...GIT_DIFF_OPTIONS, "--name-status", "-z", parent, commit],
    { ...options, encoding: null },
  );
  const changed = parseNameStatus(rawStatus);
  if (changed.length > LIMITS.changedFiles) {
    throw new Error(`Commit has ${changed.length} files; Hope Commit supports ${LIMITS.changedFiles}`);
  }

  const beforePaths = changed
    .filter((file) => file.providerStatus !== "added")
    .map((file) => file.previousPath ?? file.path);
  const afterPaths = changed
    .filter((file) => file.providerStatus !== "removed")
    .map((file) => file.path);
  const [rawCounts, beforeEntries, afterEntries] = await Promise.all([
    runGit(
      repositoryPath,
      ["diff", ...GIT_DIFF_OPTIONS, "--numstat", "-z", parent, commit],
      { ...options, encoding: null },
    ),
    readTreeEntries(repositoryPath, parent, beforePaths, options),
    readTreeEntries(repositoryPath, commit, afterPaths, options),
  ]);
  const countsByFile = parseNumstat(rawCounts);
  const beforeDescriptors = changed.map((file) => (
    file.providerStatus === "added"
      ? Object.freeze({ state: "absent" })
      : blobDescriptor(beforeEntries, file.previousPath ?? file.path)
  ));
  const afterDescriptors = changed.map((file) => (
    file.providerStatus === "removed"
      ? Object.freeze({ state: "absent" })
      : blobDescriptor(afterEntries, file.path)
  ));
  const blobValues = await readBlobBatch(
    repositoryPath,
    beforeDescriptors.flatMap((before, index) => [before, afterDescriptors[index]]),
    options,
  );
  const beforeValues = blobValues.filter((_, index) => index % 2 === 0);
  const afterValues = blobValues.filter((_, index) => index % 2 === 1);

  const sources = [];
  addSource(sources, "commit-title", subject, { revision: commit });
  addSource(sources, "commit-body", body, { revision: commit });
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
  const files = [];
  const textPatchesWithBinaryCounts = [];

  for (const [index, changedFile] of changed.entries()) {
    const id = `file-${index + 1}`;
    const beforePath = changedFile.previousPath ?? changedFile.path;
    const counts = countsByFile.get(changedFileKey(
      changedFile.path,
      changedFile.previousPath,
    )) ?? Object.freeze({ additions: 0, deletions: 0 });
    const before = beforeValues[index];
    const after = afterValues[index];
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
      const rawPatch = await runGit(
        repositoryPath,
        [
          "--no-literal-pathspecs",
          "diff",
          ...GIT_DIFF_OPTIONS,
          "--text",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "--unified=80",
          parent,
          commit,
          "--",
          ...[changedFile.previousPath, changedFile.path].filter(Boolean).map(exactFilePathspec),
        ],
        options,
      );
      const patch = cleanText(rawPatch);
      if (patch) {
        if (counts.binary) textPatchesWithBinaryCounts.push(rawPatch);
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
  if (textPatchesWithBinaryCounts.length > 0) {
    // --numstat은 패치를 적용하지 않고 줄 수만 반환한다.
    const patchCounts = parseNumstat(await runGit(
      repositoryPath,
      ["apply", "--numstat", "-z", "-"],
      { ...options, encoding: null, input: Buffer.from(textPatchesWithBinaryCounts.join("\n")) },
    ));
    for (const [index, file] of files.entries()) {
      const counts = patchCounts.get(changedFileKey(file.path));
      if (counts) {
        files[index] = Object.freeze({
          ...file,
          additions: counts.additions,
          deletions: counts.deletions,
        });
      }
    }
  }
  const totalChangedLines = files.reduce((total, file) => total + file.additions + file.deletions, 0);
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
  execInput,
} = {}) {
  const repositoryPath = validateRepositoryPath(collected?.repository?.path);
  const options = { exec, execInput };
  const expectedHead = validateObjectId(collected?.snapshot?.head, "head");
  const expectedBase = validateObjectId(collected?.snapshot?.base, "base");
  const [headType, baseType] = await readObjectTypes(
    repositoryPath,
    [expectedHead, expectedBase],
    options,
  );
  const currentHead = headType === "commit" ? expectedHead : undefined;
  const expectedBaseType = collected.commit.parentCount === 0 ? "tree" : "commit";
  const matches = currentHead === expectedHead && baseType === expectedBaseType;
  return Object.freeze({
    current: {
      base: matches ? expectedBase : undefined,
      head: currentHead,
      mergeBase: matches ? expectedBase : undefined,
    },
    matches,
    revalidatedAt: clock().toISOString(),
  });
}

export { readBlob as readGitBlob, unavailableReason as gitUnavailableReason };
