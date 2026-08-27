import assert from "node:assert/strict";
import test from "node:test";

import { redactionKind } from "../plugins/hope-commit/skills/commit-diff/scripts/redact.mjs";

for (const path of [".npmrc", "config/.pypirc", "home/.netrc"]) {
  test(`redacts the private package configuration path ${path}`, () => {
    assert.equal(redactionKind(path, []), "private-path");
  });
}

for (const token of [
  `npm_${"A".repeat(36)}`,
  `pypi-${"A".repeat(85)}`,
]) {
  test(`redacts the high-confidence package token ${token.slice(0, 5)}`, () => {
    assert.equal(redactionKind("config.txt", [token]), "credential-pattern");
  });
}

test("keeps package examples that do not match private names or token shapes", () => {
  assert.equal(redactionKind(".npmrc.example", ["npm_package_name=hope-commit"]), undefined);
  assert.equal(redactionKind("README.md", [`npm_${"A".repeat(35)}`]), undefined);
  assert.equal(redactionKind("README.md", [`pypi-${"A".repeat(84)}`]), undefined);
});
