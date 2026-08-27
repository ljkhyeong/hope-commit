import assert from "node:assert/strict";
import test from "node:test";

import { redactionKind as commitRedactionKind } from "../plugins/hope-commit/skills/commit/scripts/redact.mjs";
import { redactionKind as diffRedactionKind } from "../plugins/hope-commit/skills/diff/scripts/redact.mjs";

const implementations = Object.freeze([
  Object.freeze({ name: "Commit Diff", redactionKind: commitRedactionKind }),
  Object.freeze({ name: "Diff", redactionKind: diffRedactionKind }),
]);

for (const { name, redactionKind } of implementations) {
  for (const path of [
    ".git-credentials",
    ".npmrc",
    "config/.pypirc",
    "config/git/credentials",
    "home/.netrc",
  ]) {
    test(`${name}가 비공개 설정 경로 ${path}를 차단한다`, () => {
      assert.equal(redactionKind(path, []), "private-path");
    });
  }

  for (const token of [
    `npm_${"A".repeat(36)}`,
    `pypi-${"A".repeat(85)}`,
  ]) {
    test(`${name}가 신뢰도 높은 패키지 토큰 ${token.slice(0, 5)}를 차단한다`, () => {
      assert.equal(redactionKind("config.txt", [token]), "credential-pattern");
    });
  }

  test(`${name}가 설정 예시와 불완전한 토큰을 허용한다`, () => {
    assert.equal(
      redactionKind(".git-credentials.example", ["https://example.invalid"]),
      undefined,
    );
    assert.equal(redactionKind(".npmrc.example", ["npm_package_name=hope-commit"]), undefined);
    assert.equal(redactionKind("README.md", [`npm_${"A".repeat(35)}`]), undefined);
    assert.equal(redactionKind("README.md", [`pypi-${"A".repeat(84)}`]), undefined);
  });
}
