# Commit runtime guarantees

This document records deterministic guarantees for maintainers. Analysis workers
do not need to read it.

## Target identity

- Accept hexadecimal commit IDs only.
- Resolve short IDs to a full immutable object ID before collection.
- Compare a normal or merge commit with one selected parent.
- Compare a root commit with Git's empty tree.
- Reject an unavailable parent number.

## Evidence source

- Read changed content and requested context from Git objects.
- Ignore staged, unstaged, and untracked files.
- Pass every Git argument separately without shell interpolation.
- Reject absolute, parent-traversing, control-character, and backslash paths.
- Redact private configuration paths and high-confidence credential patterns.
- Bound files, changed lines, individual bodies, aggregate bodies, context,
  inspection pages, analysis, evidence, and final artifact bytes.

## Snapshot durability

- Hash the canonical snapshot and bind every page, checkpoint, ledger entry, and
  analysis file to the digest.
- Store private runs in a user-owned temporary directory with restricted
  permissions.
- Revalidate the captured Git objects before publication.
- Publish the artifact atomically only after analysis validation succeeds.

## Output

- Embed fonts, icon, styles, scripts, and evidence in one offline HTML file.
- Embed the bundled fonts' complete SIL Open Font License notices in the HTML.
- Use a restrictive Content Security Policy.
- Link evidence to immutable GitHub blob revisions only when a canonical GitHub
  origin is available.
- Preserve evidence as offline excerpts when no remote URL is available.
