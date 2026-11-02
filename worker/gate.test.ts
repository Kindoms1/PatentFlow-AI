import assert from "node:assert/strict";
import test from "node:test";
import { checkCode, clearCookie, gateConfigured, gatePage, issueCookie, redirect, SECURITY, session } from "./gate.ts";
import { environment } from "./test-helpers.ts";

function cookieRequest(cookie: string): Request {
  return new Request("https://app.example.test/", { headers: { Cookie: cookie.split(";")[0] } });
}

test("access-code configuration fails closed for empty, short, oversized and mixed invalid entries", () => {
  for (const ACCESS_CODES of [undefined, "", " , \n ", "short", "x".repeat(201), "synthetic-valid,short"]) {
    assert.equal(gateConfigured(environment({ ACCESS_CODES })), false);
  }
  for (const SESSION_SECRET of [undefined, "", "short", " ".repeat(40)]) {
    assert.equal(gateConfigured(environment({ SESSION_SECRET })), false);
  }
  assert.equal(gateConfigured(environment({ ACCESS_CODES: " synthetic-first, synthetic-second \n synthetic-third " })), true);
});

test("invalid gate configuration cannot validate codes or existing sessions", async () => {
  const env = environment();
  const tag = await checkCode(env, env.ACCESS_CODES!);
  assert.ok(tag);
  const request = cookieRequest(await issueCookie(env, tag));
  const invalid = { ...env, ACCESS_CODES: `${env.ACCESS_CODES},short` };
  assert.equal(await checkCode(invalid, env.ACCESS_CODES!), null);
  assert.equal(await session(request, invalid), null);
  await assert.rejects(issueCookie(invalid, tag), /configuration/i);
});

test("sessions validate signatures, expire and revoke when their invite is removed", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const env = environment({ ACCESS_CODES: "synthetic-first,synthetic-second", SESSION_DAYS: "1" });
  const tag = await checkCode(env, " synthetic-first " );
  assert.ok(tag);
  const cookie = await issueCookie(env, tag);
  assert.ok(cookie.endsWith("; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400"));
  const request = cookieRequest(cookie);
  assert.equal(await session(request, env), tag);
  assert.equal(await checkCode(env, "synthetic-wrong"), null);
  assert.equal(await session(cookieRequest(cookie.replace(tag, "000000000000")), env), null);
  assert.equal(await session(request, { ...env, SESSION_SECRET: "different-synthetic-secret-1234567890" }), null);
  assert.equal(await session(request, { ...env, ACCESS_CODES: "synthetic-second" }), null);
  assert.equal(await session(new Request("https://app.example.test"), env), null);
  t.mock.method(Date, "now", () => now + 86_400_000);
  assert.equal(await session(request, env), null, "expiry is exclusive, including the exact expiry instant");
  assert.match(clearCookie(), /Max-Age=0$/);
});

test("fractional session durations produce usable integer timestamps and max-age", async (t) => {
  t.mock.method(Date, "now", () => 1_800_000_000_000);
  const env = environment({ SESSION_DAYS: "1.1234567" });
  const tag = await checkCode(env, env.ACCESS_CODES!);
  assert.ok(tag);
  const cookie = await issueCookie(env, tag);
  assert.match(cookie, /Max-Age=\d+$/);
  assert.equal(await session(cookieRequest(cookie), env), tag);
});

test("gate responses and redirects include security headers and disable caching", () => {
  for (const response of [gatePage(null), gatePage("<script>"), redirect("/", clearCookie())]) {
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    for (const [name, value] of Object.entries(SECURITY)) assert.equal(response.headers.get(name), value);
  }
});
