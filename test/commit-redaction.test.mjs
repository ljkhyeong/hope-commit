import assert from "node:assert/strict";
import test from "node:test";

import { redactionKind } from "../plugins/hope/review-core/redact.mjs";

for (const path of [
  ".git-credentials",
  ".npmrc",
  "config/.pypirc",
  "config/git/credentials",
  "home/.netrc",
]) {
  test(`공유 검토 보안 규칙이 비공개 설정 경로 ${path}를 차단한다`, () => {
    assert.equal(redactionKind(path, []), "private-path");
  });
}

for (const token of [
  `npm_${"A".repeat(36)}`,
  `pypi-${"A".repeat(85)}`,
]) {
  test(`공유 검토 보안 규칙이 신뢰도 높은 패키지 토큰 ${token.slice(0, 5)}를 차단한다`, () => {
    assert.equal(redactionKind("config.txt", [token]), "credential-pattern");
  });
}

test("공유 검토 보안 규칙이 설정 예시와 불완전한 토큰을 허용한다", () => {
  assert.equal(
    redactionKind(".git-credentials.example", ["https://example.invalid"]),
    undefined,
  );
  assert.equal(redactionKind(".npmrc.example", ["npm_package_name=hope-commit"]), undefined);
  assert.equal(redactionKind("README.md", [`npm_${"A".repeat(35)}`]), undefined);
  assert.equal(redactionKind("README.md", [`pypi-${"A".repeat(84)}`]), undefined);
});
