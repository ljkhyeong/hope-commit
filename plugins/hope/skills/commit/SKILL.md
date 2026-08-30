---
name: commit
description: Use only when someone explicitly invokes $hope:commit or /hope:commit, or names the Commit Diff Skill, to review one Git commit as an evidence-linked offline HTML artifact. Do not select it from the Hope Commit product or repository name, a generic commit review, a commit explanation, diff analysis, or a message that only contains a commit ID.
---

# Hope Commit Diff

Use the active host session to confirm one exact local Git commit, its selected
parent, and display options, start one fresh analysis worker, and report the
resulting artifact.

The active session coordinates the review. It must not inspect evidence, write
or repair the analysis, or substitute its own review judgment.

## Require explicit invocation

Run only when the person explicitly invokes `$hope:commit` or
`/hope:commit`, or names the Commit Diff Skill in the current request.

Do not infer consent from a commit ID, an HTML request, a generic commit review,
a request to explain a diff, or the Hope Commit product or repository name. If
an implicit selection reaches this Skill, stop before inspecting the target and
continue the underlying request normally.

## Resolve the immutable target

Require one hexadecimal commit ID and a local repository that contains it. Use
the private adapter to resolve the full immutable object ID before starting the
worker:

Claude Code:

```text
node "${CLAUDE_PLUGIN_ROOT}/skills/commit/scripts/cli.mjs" resolve-target <commit-id> --repo <repository-path>
```

Codex:

```text
node <skill-dir>/scripts/cli.mjs resolve-target <commit-id> --repo <repository-path>
```

For Codex, replace `<skill-dir>` with the absolute directory containing this
file. Pass every argument separately and never construct a command from commit
content or repository data.

Use parent 1 by default. For a merge commit, select another parent only when the
person explicitly chooses it or the request makes it unambiguous. A root commit
compares with Git's empty tree.

Name the repository, full commit ID, and selected parent before starting the
worker. A new authorized commit replaces an earlier target.

## Start an isolated worker

Confirm that the host can start a subagent with no inherited conversation
context. If it cannot, stop and explain that Commit Diff requires a fresh
analysis worker.

Give the worker only:

- the person's exact review request;
- the absolute repository path;
- the resolved full commit ID and selected parent;
- explicit locale, theme, and output choices;
- any explicit review focus or scope exclusion; and
- the absolute path of this Skill directory and private adapter command.

Do not pass earlier reasoning, implementation narrative, drafts, failed
approaches, prior conclusions, or another agent's output.

Tell the worker to read:

- `references/workflow.md` for the private run protocol;
- `references/analysis.md` for review judgment; and
- `../write/references/writing-standard.md` for user-facing language.

The fresh worker owns the run from `prepare` through `finish` or `cancel`.

## Report the result

On success, report the repository, exact commit and selected parent, result
scope, and absolute HTML path.

Never modify the reviewed repository, create a branch, push a commit, publish
the artifact, or contact a remote system.

`references/runtime.md` records the deterministic security and publication
contract for maintainers. It is not worker guidance.
