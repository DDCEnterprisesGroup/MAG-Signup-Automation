import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUrl, safeUrl, sameSiteHost } from "../src/utils/text.js";

test("normalizes URLs for runtime duplicate protection", () => {
  assert.equal(normalizeUrl("HTTPS://WWW.Example.com/signup/?utm_source=x&b=2&a=1#top"), "https://example.com/signup?a=1&b=2");
  assert.equal(normalizeUrl("example.com"), "https://example.com/");
});

test("removes credentials, query parameters, and fragments from durable logs", () => {
  assert.equal(safeUrl("https://user:pass@example.com/path?token=secret#code"), "https://example.com/path");
});

test("recognizes same-host and subdomain redirects", () => {
  assert.equal(sameSiteHost("https://example.com/signup", "https://accounts.example.com/register"), true);
  assert.equal(sameSiteHost("https://example.com", "https://unrelated.test"), false);
});
