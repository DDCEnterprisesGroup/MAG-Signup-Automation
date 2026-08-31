import assert from "node:assert/strict";
import test from "node:test";
import { hasIdentityAnchor, prefilledValueConflicts } from "../src/forms/prefill-check.js";

test("email conflicts only when both are real, different addresses", () => {
  assert.equal(prefilledValueConflicts("email", "other@evil.invalid", "me@example.invalid"), true);
  assert.equal(prefilledValueConflicts("email", "ME@example.invalid", "me@example.invalid"), false);
  assert.equal(prefilledValueConflicts("email", "", "me@example.invalid"), false);
  assert.equal(prefilledValueConflicts("email", "not-an-email", "me@example.invalid"), false);
});

test("phone compares the last ten digits and ignores formatting", () => {
  assert.equal(prefilledValueConflicts("phone", "(555) 555-0100", "5555550100"), false);
  assert.equal(prefilledValueConflicts("phone", "+1 555 555 0100", "555-555-0100"), false);
  assert.equal(prefilledValueConflicts("phone", "555-555-9999", "5555550100"), true);
});

test("zip compares the first five digits", () => {
  assert.equal(prefilledValueConflicts("zip", "32606-1234", "32606"), false);
  assert.equal(prefilledValueConflicts("zip", "90210", "32606"), true);
});

test("state treats abbreviations and full names as equivalent", () => {
  assert.equal(prefilledValueConflicts("state", "Florida", "FL"), false);
  assert.equal(prefilledValueConflicts("state", "fl", "Florida"), false);
  assert.equal(prefilledValueConflicts("state", "California", "FL"), true);
});

test("names conflict only on a clear mismatch, not on formatting or partials", () => {
  assert.equal(prefilledValueConflicts("firstName", "Jon", "Jon"), false);
  assert.equal(prefilledValueConflicts("lastName", "O'Brien", "O Brien"), false);
  assert.equal(prefilledValueConflicts("firstName", "Alexander", "Alex"), false); // one contains the other
  assert.equal(prefilledValueConflicts("lastName", "Smith", "Jones"), true);
});

test("unchecked field types never report a conflict", () => {
  assert.equal(prefilledValueConflicts("address", "1 Foo St", "999 Bar Ave"), false);
  assert.equal(prefilledValueConflicts("annualIncome", "1", "999999"), false);
});

test("hasIdentityAnchor needs an email or a full name", () => {
  assert.equal(hasIdentityAnchor(new Set()), false);
  assert.equal(hasIdentityAnchor(new Set(["firstName"])), false);
  assert.equal(hasIdentityAnchor(new Set(["email"])), true);
  assert.equal(hasIdentityAnchor(new Set(["firstName", "lastName"])), true);
});
