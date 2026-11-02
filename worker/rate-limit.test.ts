import assert from "node:assert/strict";
import test from "node:test";
import { RateLimiter } from "./rate-limit.ts";

test("sliding windows expire hits at the exact boundary and rejected requests do not extend it", () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 0), true);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 100), true);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 999), false);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 1000), true);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 1099), false);
  assert.equal(limiter.allow("synthetic-client", 2, 1000, 1100), true);
});

test("keys are independent, zero disables the check, and separate isolates do not share quotas", () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.allow("synthetic-a", 1, 1000, 0), true);
  assert.equal(limiter.allow("synthetic-a", 1, 1000, 0), false);
  assert.equal(limiter.allow("synthetic-b", 1, 1000, 0), true);
  assert.equal(limiter.allow("synthetic-a", 0, 1000, 0), true);
  assert.equal(new RateLimiter().allow("synthetic-a", 1, 1000, 0), true);
});
