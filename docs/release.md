# Hope releases

This document defines the release of Hope's current plugin distribution.

It does not define feature behavior.

Hope publishes one verified package and matching source tag for each public
version.

## Release decision

Every completed change records one release decision in its pull request:

- `none` when the change does not alter the public package;
- `patch` for a backward-compatible correction;
- `minor` for a backward-compatible capability; or
- `major` for an incompatible public change.

Judge the delivered behavior, not the commit type.

AI or the reviewer chooses `patch`, `minor`, or `major` when a release is
required.

The repository determines whether the working tree changes the public package
and calculates the exact version.

Documentation and internal maintenance can still require a release when they
change a Skill or another packaged contract.

A `none` decision changes no version file solely to record the decision.

## Local completion gate

Every file-changing task ends with:

```bash
npm run check
```

The command checks the package structure, the current working tree's release
impact, and the deterministic tests.

The release-impact check compares the approved package at the latest stable
release, the latest `origin/main`, and the current working tree.

It compares the exact package allowlist, file modes, and file contents after
replacing only the two manifest version values with one neutral value.

When the working tree changes the package, it must increase the base version by
exactly one patch, minor, or major step.

When the base already records an unreleased version, unrelated work keeps that
version.

When the base has unversioned package changes, the next completed task records
their release unless it restores the package to the released state.

A branch must include the latest `origin/main` before the check can pass.

The same command runs in normal CI as a safety net, but local completion owns
the version decision.

## Prepare a version

Before preparing a version, update the branch from the latest `main`.

The public version files are:

- `package.json`;
- `package-lock.json`;
- `plugins/hope/.codex-plugin/plugin.json`; and
- `plugins/hope/.claude-plugin/plugin.json`.

For a `patch`, `minor`, or `major` decision, run:

```bash
npm run release:prepare -- <patch|minor|major>
```

The command reads the version from `origin/main`, calculates the exact next
version, updates all four files, rebuilds the package, and runs its checks.

Pass another base ref as a second argument only when `origin/main` is not the
task base.

Run `npm run check` again and commit the version with the work it releases.

The pull request therefore contains both the product change and its release
decision before review and merge.

## Publish the recorded version

Every push to `main` runs `Verify`. After all supported Node.js versions,
platform smoke checks, and browser checks pass, that completed run starts the
`Release` workflow.

The repository accepts `main` changes only through pull requests that pass
`Verify` and `AI-readable change title`. It allows squash merges, prevents
force pushes, and prevents deleting `main`.

Release accepts only a successful `Verify` run for a `main` push from this
repository. It checks out the exact commit verified by that run.

검증된 커밋이 버전을 변경하지 않았고 해당 태그와 공개된 GitHub Release가
모두 있으면 새로 게시하지 않고 종료합니다. 현재 버전에 태그가 없는데
검증된 커밋이 버전도 변경하지 않았다면 누락되거나 중단된 릴리스를 확인할 수
있도록 실패로 종료합니다.

릴리스 초안은 게시 완료로 보지 않습니다. 자동·수동 실행 모두 초안이 있으면
오류를 내고 중단하며, 초안을 삭제하거나 공개하지 않습니다. GitHub 상태 조회가
실패해도 릴리스가 없는 것으로 처리하지 않고 중단합니다.

For a new version, it checks the recorded package, stages and verifies the
archive, and then creates the tag and GitHub Release.

The workflow never chooses a version, changes `main`, or lets a later unchanged
commit claim an earlier version.

Release jobs share one queue so two releases never publish at the same time.

GitHub generates the public release notes from the commits and merged pull
requests since the previous tag.

## Manual retry and recovery

A manual run uses the selected `main` commit, not a moving branch reference.

태그와 공개된 GitHub Release가 모두 있으면 새로 게시하지 않고 종료합니다.

If neither exists, the run checks and publishes that recorded version.

If the tag exists without a GitHub Release, the run restores the tagged commit,
checks its package again, and publishes the missing release.

초안 때문에 중단됐다면 먼저 이전 실행 로그, 초안의 릴리스 노트와 첨부 파일을
확인합니다. 필요한 내용을 별도로 보관하고, 다시 만들기로 결정한 초안만 직접
삭제합니다. 기존 Git 태그는 삭제하거나 옮기지 않습니다. 그 뒤 `main`에서
수동 릴리스를 실행하면 위 절차에 따라 검증된 패키지로 릴리스를 다시 만듭니다.

GitHub locks the tag and assets after an immutable Release is published. This
setting applies only to Releases published after it is enabled. `v4.0.0`
remains the unchanged historical exception, and its tag is protected by the
repository's `v*` tag ruleset.
