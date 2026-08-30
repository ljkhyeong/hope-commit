# Commit Diff runtime contract

This maintainer reference records the deterministic guarantees enforced by
Commit Diff's scripts. `SKILL.md` owns coordination, `workflow.md` owns the
worker protocol, and `analysis.md` owns review judgment.

## Exact, immutable source

Commit Diff accepts hexadecimal commit IDs, resolves one full immutable object
ID, and compares it with one selected parent. A root commit compares with Git's
empty tree.

부모 목록은 커밋 객체에서 직접 읽습니다. 선택한 부모가 얕은 복제에 없으면 이력을
더 받아야 한다고 안내하고 중단하며, 자동으로 원격 저장소에 접속하지 않습니다.
모든 Git 객체 읽기는 `git replace`의 대체 객체를 무시합니다.

Changed content and requested context come from Git objects. Staged, unstaged,
and untracked files do not enter the snapshot. The runtime rejects unsafe paths,
redacts private configuration and high-confidence credentials, and bounds every
file, source body, inspection page, analysis, evidence range, and artifact.

본문을 수집할 수 있는 텍스트 파일은 로컬 `-diff` 속성이 있어도 텍스트 패치와
변경 줄 수를 수집합니다. 바이너리, 크기 제한 초과 파일과 비밀정보 제외 기준은
그대로 적용하며, 외부 diff와 textconv 명령은 실행하지 않습니다.

The model selects a focused continuous interval. The runtime validates and
splits it into bounded rendered references without dropping selected lines. It
derives file accounting, scope, links, source excerpts, and resource counters
instead of trusting authored copies.

Before publication, Commit Diff confirms that the captured commit and parent
objects still exist. Missing objects stop publication rather than presenting an
unverifiable review.

## Untrusted, bounded input

Repository content, Git metadata, paths, model output, and output locations are
untrusted. The runtime bounds their size and structure, validates
cross-references, and escapes authored content into one self-contained HTML
file. The artifact needs neither repository dependencies nor a network request.

Validation rejects malformed, ungrounded, duplicate, or over-budget authored
data where the scripts can decide that deterministically. Meaning,
proportionality, and overlapping-but-distinct claims remain analysis judgments.

Each successful adapter step returns `next`, a structured description of the
state transitions allowed by the current run. Mandatory inspection,
checkpointing, ledger, validation, and finish transitions are runtime-owned.
The only model choice is whether a grounded pending context request would close
a material review question. These descriptors are state data, not shell command
strings, and remain valid only for the run identity that returned them.

Commit Diff does not run CI, tests, builds, or lint. When analysis makes that
absence material, the runtime requires a linked verification item.

## Owned state and publication

Each run owns one restricted temporary directory and records the directory
identity needed to remove it. Cleanup claims the exact owned directory and
preserves a path whose identity becomes uncertain. Interrupted cleanup can
resume after the internal manifest has already been removed.

Publication creates a new artifact and never replaces an existing path. It
rechecks run ownership after taking the mutation lock and immediately before
publication. A failed collection, validation, render, revalidation, or
publication does not publish a partial review.

A retryable repository or publication failure preserves the validated run.
After successful publication, Commit Diff removes it. If cleanup then fails,
Commit Diff reports both the published artifact and the remaining cleanup work
instead of publishing again.

The artifact embeds its fonts, icon, styles, scripts, evidence, and complete SIL
Open Font License notices in one offline HTML file.
