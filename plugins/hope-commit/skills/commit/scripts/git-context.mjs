import { LIMITS } from "./constants.mjs";
import { gitUnavailableReason, readGitBlob } from "./git.mjs";
import { redactionKind } from "./redact.mjs";
import { containsBidiControl } from "./text.mjs";

const revisionKinds = new Set(["head", "merge-base"]);

function validateObjectId(value, kind) {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/iu.test(value)) {
    throw new Error(`Hope Commit context needs an immutable ${kind} revision`);
  }
  return value;
}

export function validateContextPath(value) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(JSON.stringify(value), "utf8") > LIMITS.contextPathJsonBytes
    || value.startsWith("/")
    || /^[A-Za-z]:/u.test(value)
    || value.includes("\\")
    || containsBidiControl(value)
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Hope Commit context needs a normal repository-relative path");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Hope Commit context needs a normal repository-relative path");
  }
  return value;
}

function validateRequests(snapshot, requests) {
  if (!Array.isArray(requests)) {
    throw new TypeError("Hope Commit context requests must be an array");
  }
  if (requests.length > LIMITS.contextFiles) {
    throw new Error(`Hope Commit context supports ${LIMITS.contextFiles} requests`);
  }
  const repositoryPath = snapshot?.repository?.path;
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0) {
    throw new Error("Hope Commit context needs a captured repository path");
  }
  const seen = new Set();
  const values = requests.map((request) => {
    if (
      !request
      || typeof request !== "object"
      || Array.isArray(request)
      || Object.keys(request).some((key) => !["path", "revision"].includes(key))
      || !Object.hasOwn(request, "path")
      || !Object.hasOwn(request, "revision")
    ) {
      throw new Error("Hope Commit context received an invalid request");
    }
    const path = validateContextPath(request.path);
    if (!revisionKinds.has(request.revision)) {
      throw new Error("Hope Commit context revision must be head or merge-base");
    }
    const revision = validateObjectId(
      request.revision === "head"
        ? snapshot.snapshot.head
        : snapshot.snapshot.mergeBase,
      request.revision,
    );
    const key = `${revision}\u0000${path}`;
    if (seen.has(key)) {
      throw new Error("Hope Commit context requests must be unique");
    }
    seen.add(key);
    return Object.freeze({ path, revision });
  });
  return Object.freeze({ repositoryPath, values: Object.freeze(values) });
}

function unavailable(path, revision, reasonKind, reason) {
  return Object.freeze({
    kind: "context-unavailable",
    path,
    reason,
    reasonKind,
    revision,
  });
}

function included(path, revision, text) {
  return Object.freeze({
    kind: "context-file",
    path,
    revision,
    text,
  });
}

function exceedsInspectionLineLimit(text) {
  return text.split("\n").some((line) => (
    Buffer.byteLength(JSON.stringify(line), "utf8") + 2
      > LIMITS.contextLineJsonBytes
  ));
}

export async function collectLocalGitContext(snapshot, requests, {
  existingBytes = 0,
  exec,
} = {}) {
  if (
    !Number.isSafeInteger(existingBytes)
    || existingBytes < 0
    || existingBytes > LIMITS.contextBodyTotalBytes
  ) {
    throw new Error("Hope Commit context has an invalid existing byte count");
  }
  const { repositoryPath, values } = validateRequests(snapshot, requests);
  const options = exec ? { exec } : {};
  const collected = await Promise.all(values.map(async ({ path, revision }) => {
    const privateKind = redactionKind(path, []);
    if (privateKind) {
      return unavailable(path, revision, privateKind, gitUnavailableReason(privateKind));
    }
    const content = await readGitBlob(repositoryPath, revision, path, options);
    if (content.state === "absent") {
      return unavailable(
        path,
        revision,
        "not-found",
        "Git did not find this path at the captured revision",
      );
    }
    if (content.state !== "text") {
      return unavailable(
        path,
        revision,
        content.reasonKind,
        content.reason,
      );
    }
    const redaction = redactionKind(path, [content.text]);
    if (redaction) {
      return unavailable(path, revision, redaction, gitUnavailableReason(redaction));
    }
    if (exceedsInspectionLineLimit(content.text)) {
      return unavailable(
        path,
        revision,
        "inspection-line-limit",
        "The requested context has a line too long for bounded inspection pages",
      );
    }
    return included(path, revision, content.text);
  }));

  let total = existingBytes;
  return Object.freeze(collected.map((candidate) => {
    if (candidate.kind !== "context-file") return candidate;
    total += Buffer.byteLength(candidate.text, "utf8");
    if (total > LIMITS.contextBodyTotalBytes) {
      return unavailable(
        candidate.path,
        candidate.revision,
        "context-size-limit",
        `Collected context exceeds Hope Commit's ${LIMITS.contextBodyTotalBytes}-byte limit`,
      );
    }
    return candidate;
  }));
}
