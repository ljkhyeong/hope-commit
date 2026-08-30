import { exposeBidiControls } from "../../../review-core/text.mjs";

function escapeHtml(value) {
  return exposeBidiControls(String(value ?? ""))
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function diffLineKind(content, inHunk) {
  if (content.startsWith("+") && (inHunk || !content.startsWith("+++"))) return "added";
  if (content.startsWith("-") && (inHunk || !content.startsWith("---"))) return "removed";
  if (content.startsWith("@@")) return "hunk";
  if (content.startsWith(" ")) return "context";
  return "meta";
}

export function patchLineLocations(lines) {
  let oldLine;
  let newLine;
  let oldRemaining = 0;
  let newRemaining = 0;
  return lines.map((content) => {
    const hunk = content.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldRemaining = Number(hunk[2] ?? 1);
      newLine = Number(hunk[3]);
      newRemaining = Number(hunk[4] ?? 1);
      return Object.freeze({ kind: "hunk" });
    }

    const inHunk = oldRemaining > 0 || newRemaining > 0;
    const kind = diffLineKind(content, inHunk);
    if (!inHunk) {
      return Object.freeze({ kind });
    }
    if (kind === "added") {
      const result = Object.freeze({ kind, newLine });
      newLine += 1;
      newRemaining -= 1;
      return result;
    }
    if (kind === "removed") {
      const result = Object.freeze({ kind, oldLine });
      oldLine += 1;
      oldRemaining -= 1;
      return result;
    }
    if (kind === "context") {
      const result = Object.freeze({ kind, newLine, oldLine });
      newLine += 1;
      oldLine += 1;
      newRemaining -= 1;
      oldRemaining -= 1;
      return result;
    }
    return Object.freeze({ kind });
  });
}

function sourceLine(content) {
  return "<span class=\"code-line\"><span class=\"code-content\">"
    + `${escapeHtml(content)}</span></span>`;
}

export function renderCodeEvidence(evidence) {
  const excerpt = String(evidence.excerpt ?? "");
  if (evidence.sourceKind !== "patch") {
    return excerpt.split("\n").map(sourceLine).join("\n");
  }

  const lines = excerpt.split("\n");
  const locations = evidence.patchLocations ?? patchLineLocations(lines);
  return lines.map((text, index) => {
    const line = locations[index];
    const codeLine = ["added", "removed", "context"].includes(line.kind);
    const prefix = codeLine ? text.slice(0, 1) : "";
    const content = codeLine ? text.slice(1) : text;
    const coordinates = line.oldLine === undefined && line.newLine === undefined
      ? ""
      : ` data-old-line="${line.oldLine ?? ""}" data-new-line="${line.newLine ?? ""}"`;
    const coordinateClass = coordinates ? "" : " code-line-unlocated";
    const prefixHtml = prefix
      ? `<span class="code-prefix">${escapeHtml(prefix)}</span>`
      : "";
    return `<span class="code-line code-line-patch code-line-${line.kind}${coordinateClass}"${coordinates}>`
      + `<span class="code-content">${prefixHtml}${escapeHtml(content)}</span></span>`;
  }).join("\n");
}
