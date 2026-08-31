# Commit Diff runtime contract

This maintainer reference records the deterministic guarantees enforced by
Commit Diff's scripts. `SKILL.md` owns coordination, `workflow.md` owns the
worker protocol, and `analysis.md` owns review judgment.

## Exact, immutable source

Commit Diff accepts hexadecimal commit IDs, resolves one full immutable object
ID, and compares it with one selected parent. A root commit compares with Git's
empty tree.

대상 확인과 수집은 같은 커밋 객체 조회 함수를 사용합니다. 입력한 ID와 같은
이름의 브랜치·태그가 있어도 해당 참조를 따라가지 않습니다. 접두사에 일치하는
커밋 객체가 하나일 때만 선택하며, 여러 커밋이 일치하면 더 긴 ID를 요청합니다.
일치하는 커밋이 없는 ID와 파일·주석 태그의 객체 ID는 받지 않습니다.

부모 목록은 커밋 객체에서 직접 읽습니다. 선택한 부모가 얕은 복제에 없으면 이력을
더 받아야 한다고 안내하고 중단하며, 자동으로 원격 저장소에 접속하지 않습니다.
모든 Git 객체 읽기는 `git replace`의 대체 객체를 무시합니다.

대상 확인, 변경 수집, 맥락 조회와 재검증은 같은 Git 실행 함수를 사용합니다.
대상 확인과 변경 수집은 같은 저장소 경로 해석 함수를 사용합니다.
Git이 출력 끝에 붙인 줄바꿈 하나만 제거하며, 실제 폴더명의 끝 공백과 줄바꿈은
그대로 보존합니다. 파일 접근 경로에 표시용 텍스트 변환을 적용하지 않습니다.
저장소와 경로 선택을 바꾸는 환경변수는 자식 프로세스에서 제외합니다.
`--no-lazy-fetch`로 부분 복제의 누락 객체를 자동 다운로드하지 않으며, 필요한
객체가 로컬에 없으면 수집을 중단합니다. 이 옵션을 지원하지 않는 Git에서도
차단 없이 계속 실행하지 않습니다.

커밋 제목·본문·작성자·작성 시각은 UTF-8로 조회합니다. 저장소의 서명 표시
설정과 관계없이 서명 확인 프로그램을 실행하지 않습니다.
커밋 본문은 `commit-body` 근거 자료에서 페이지별로 나눠 전달합니다.
검토 페이지와 최종 분석 목록의 요약에는 본문을 중복으로 넣지 않으며,
수집된 원문을 자르거나 변경하지 않습니다.

Changed content and requested context come from Git objects. Staged, unstaged,
and untracked files do not enter the snapshot. The runtime rejects unsafe paths,
redacts private configuration and high-confidence credentials, and bounds every
file, source body, inspection page, analysis, evidence range, and artifact.

본문을 수집할 수 있는 텍스트 파일은 로컬 `-diff` 속성이 있어도 텍스트 패치와
변경 줄 수를 수집합니다. 바이너리, 크기 제한 초과 파일과 비밀정보 제외 기준은
그대로 적용하며, 외부 diff와 textconv 명령은 실행하지 않습니다.
일반 파일과 심볼릭 링크 사이의 변경에서 패치가 같은 경로의 삭제·추가로
나뉘면 두 항목의 줄 수를 합산합니다.

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
패치에서 변경되지 않은 빈 줄도 앞의 공백을 유지합니다.
`diff.suppressBlankEmpty`는 Git 실행 중에만 끄고 저장소 설정 파일은 바꾸지 않습니다.

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

맥락 용량은 실제 포함한 파일만 합산합니다. 큰 파일을 용량 초과로 제외해도
남은 용량에 들어오는 뒤의 파일은 수집합니다.

Validation rejects malformed, ungrounded, duplicate, or over-budget authored
data where the scripts can decide that deterministically. Meaning,
proportionality, and overlapping-but-distinct claims remain analysis judgments.

같은 검토 항목에서 여러 파일의 수집 제외 사유를 함께 설명할 수 있습니다.
연결 ID 수는 실제 수집된 제한 목록까지 허용하며, 중복·알 수 없는 ID와 설명에서
빠진 제한은 계속 거절합니다.

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
기본 경로와 새 경로 모두 실제 저장 단계에서 심볼릭 링크를 해석한 위치를
검사합니다. 정리 대상인 임시 분석 저장소 안에는 결과를 저장하지 않습니다.
저장 직전과 완료 시점에 출력 폴더의 실제 위치와 식별자를 다시 확인합니다.
상위 폴더가 이동하거나 교체되면 저장을 실패로 처리하고 분석을 보존합니다.
실패한 저장에서 만든 파일은 소유권이 확인되는 경우에만 정리합니다.

The artifact embeds its fonts, icon, styles, scripts, evidence, and complete SIL
Open Font License notices in one offline HTML file.
