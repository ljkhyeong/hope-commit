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

대상 확인, 변경 수집, 맥락 조회와 재검증은 같은 Git 실행 함수를 사용합니다.
저장소와 경로 선택을 바꾸는 환경변수는 자식 프로세스에서 제외합니다.
`--no-lazy-fetch`로 부분 복제의 누락 객체를 자동 다운로드하지 않으며, 필요한
객체가 로컬에 없으면 수집을 중단합니다. 이 옵션을 지원하지 않는 Git에서도
차단 없이 계속 실행하지 않습니다.

커밋 제목·본문·작성자·작성 시각은 UTF-8로 조회합니다. 저장소의 서명 표시
설정과 관계없이 서명 확인 프로그램을 실행하지 않습니다.

Changed content and requested context come from Git objects. Staged, unstaged,
and untracked files do not enter the snapshot. The runtime rejects unsafe paths,
redacts private configuration and high-confidence credentials, and bounds every
file, source body, inspection page, analysis, evidence range, and artifact.

본문을 수집할 수 있는 텍스트 파일은 로컬 `-diff` 속성이 있어도 텍스트 패치와
변경 줄 수를 수집합니다. 바이너리, 크기 제한 초과 파일과 비밀정보 제외 기준은
그대로 적용하며, 외부 diff와 textconv 명령은 실행하지 않습니다.

파일별 패치는 변경 전·후의 정확한 파일 경로만 선택합니다. 파일과 디렉터리가
서로 바뀌어도 비공개 하위 파일의 본문이 다른 파일의 패치에 포함되지 않으며,
상하위 디렉터리 사이의 파일 이동도 이름 변경 패치로 보존합니다.
서브모듈 무시 설정과 관계없이 커밋의 서브모듈 변경은 파일 목록에 포함합니다.

리뷰에는 본문을 수집할 수 있는 텍스트 변경 파일이 최소 하나 필요합니다.
빈 커밋이나 바이너리·서브모듈·비공개 파일 등 본문이 제외된 파일만 변경한
커밋은 준비 단계에서 안내하고 중단합니다. 이때 분석 실행이나 임시 분석 파일을
만들지 않습니다.

The model selects a focused continuous interval. The runtime validates and
splits it into bounded rendered references without dropping selected lines. It
derives file accounting, scope, links, source excerpts, and resource counters
instead of trusting authored copies.

패치 줄 번호와 변경 종류는 전체 패치에서 계산한 뒤 선택한 인용 구간만 표시합니다.
본문의 `+++`·`---`를 파일 헤더로 처리하지 않습니다. CRLF는 LF로 통일하고,
단독 CR은 `\u000D`로 표시해 Git 원본의 줄 수를 유지합니다.

Before publication, Commit Diff confirms that the captured commit and parent
objects still exist. Missing objects stop publication rather than presenting an
unverifiable review.

객체가 없는 경우와 Git 명령 실행 실패를 구분합니다. 접근 오류 등으로 재검증할 수
없으면 작성한 분석을 보존하고 같은 실행에서 발행을 재시도할 수 있게 합니다.

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

`finish`에서 새 저장 경로를 지정해도 기존 파일은 덮어쓰지 않습니다.
완료 후 삭제할 임시 분석 폴더 안에는 결과를 저장하지 않습니다.

The artifact embeds its fonts, icon, styles, scripts, evidence, and complete SIL
Open Font License notices in one offline HTML file.
