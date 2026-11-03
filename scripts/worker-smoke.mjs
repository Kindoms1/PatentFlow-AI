// End-to-end check of the Worker running under "wrangler dev".
// BASE=http://127.0.0.1:8787 MOCK=1 node scripts/worker-smoke.mjs   (invite code read from .dev.vars)
import fs from "node:fs";
import { NOTICE_VERSION } from '../src/site-info.ts';

const BASE = process.env.BASE || "http://127.0.0.1:8787";
const MOCK = process.env.MOCK === "1";
const MOCK_BASE = process.env.MOCK_BASE || "http://127.0.0.1:8789";
const AGENT_TIMEOUT = MOCK ? 15000 : 180000;
const vars = {};
const varsFile = process.env.VARS_FILE || ".dev.vars";
for (const line of (fs.existsSync(varsFile) ? fs.readFileSync(varsFile, "utf8") : "").split(/\r?\n/)) {
  const index = line.indexOf("=");
  if (index > 0) vars[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^"|"$/g, "");
}
const CODE = process.env.CODE || (vars.ACCESS_CODES || "").split(",")[0];
const SECRETS = [vars.AGNES_API_KEY, vars.ANYSEARCH_API_KEY, vars.SESSION_SECRET].filter((item) => item && item.length >= 8);
let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  let safeInfo = String(info ?? "");
  for (const secret of SECRETS) safeInfo = safeInfo.split(secret).join("[REDACTED]");
  console.log((ok ? "PASS " : "FAIL ") + name + (info !== undefined ? " | " + safeInfo.replace(/\s+/g, " ").slice(0, 160) : ""));
}
const clean = (text) => !SECRETS.some((secret) => text.includes(secret));
const access = await fetch(BASE + '/api/access').then(r => r.json());
const OPEN = access.mode === 'public';

let r = await fetch(BASE + "/", { redirect: "manual" });
let t = await r.text();
check(OPEN ? '首次打开首页 -> 无邀请码公告页' : '未登录打开首页 -> 邀请码页 401', r.status === (OPEN ? 200 : 401) && t.includes(OPEN ? '无需邀请码' : '邀请码'), r.status);
r = await fetch(BASE + "/assets/", { redirect: "manual" });
check('未知悉公告拿不到前端代码', r.status === (OPEN ? 200 : 401), r.status);
r = await fetch(BASE + "/api/providers");
check('未知悉公告调用 API 被拒绝', r.status === (OPEN ? 428 : 401), r.status);
r = await fetch(BASE + (OPEN ? '/__notice' : '/__access'), { method: 'POST', body: new URLSearchParams(OPEN ? { notice: 'invalid-version' } : { code: 'wrong-code-123' }), redirect: 'manual' });
check(OPEN ? '无效公告版本不发 cookie' : '错误邀请码不发 cookie', r.status === (OPEN ? 200 : 303) && !r.headers.get('set-cookie'), r.status);
r = await fetch(BASE + (OPEN ? '/__notice' : '/__access'), { method: 'POST', body: new URLSearchParams(OPEN ? { notice: NOTICE_VERSION } : { code: CODE, notice: NOTICE_VERSION }), redirect: 'manual' });
const setCookie = r.headers.get("set-cookie") || "";
const cookie = setCookie.split(";")[0];
check(OPEN ? '无需邀请码确认公告 -> HttpOnly cookie' : '正确邀请码 -> HttpOnly cookie', r.status === 303 && cookie.startsWith('pf_session=') && /HttpOnly/i.test(setCookie), r.status);
r = await fetch(BASE + "/api/providers", { headers: { Cookie: cookie.slice(0, -3) + "AAA" } });
check('篡改 cookie 被拒绝', r.status === (OPEN ? 428 : 401), r.status);

const H = { Cookie: cookie, "Content-Type": "application/json" };
r = await fetch(BASE + "/", { headers: { Cookie: cookie } });
t = await r.text();
check("登录后返回前端页面", r.status === 200 && t.includes("id=\"root\""), r.status);
r = await fetch(BASE + "/some/spa/route", { headers: { Cookie: cookie } });
check("SPA 路由回落 index.html", r.status === 200, r.status);
r = await fetch(BASE + "/api/providers", { headers: H });
t = await r.text();
check("/api/providers 不含密钥", r.status === 200 && clean(t) && t.includes("hasKey"), t);
r = await fetch(BASE + "/api/providers/import", { method: "POST", headers: H, body: "{}" });
check("线上禁止导入/改密钥 -> 403", r.status === 403, r.status);
r = await fetch(BASE + "/api/ccswitch", { headers: H });
check("CC Switch 不对外 -> 403", r.status === 403, r.status);
r = await fetch(BASE + "/api/chat", { method: "POST", headers: { ...H, Origin: "https://evil.example" }, body: "{}" });
check("跨站 Origin -> 403", r.status === 403, r.status);
r = await fetch(BASE + "/api/chat", { method: "POST", headers: H, body: "not json" });
check("非法 JSON -> 400", r.status === 400, r.status);
r = await fetch(BASE + "/api/chat", { method: "POST", headers: H, body: JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2_100_000) }] }) });
check("超大请求 -> 413", r.status === 413, r.status);

const ask = { messages: [{ role: "user", content: "只回复两个字：收到" }], maxTokens: 64 };
r = await fetch(BASE + "/api/chat", { method: "POST", headers: H, body: JSON.stringify(ask) });
t = await r.text();
let j = {};
try {
  j = JSON.parse(t);
} catch {}
check("/api/chat 转发到模型并返回", r.status === 200 && j.ok === true && Boolean(j.text), j.text || j.detail || t);
check("/api/chat 响应不含密钥", clean(t));

const t0 = Date.now();
r = await fetch(BASE + "/api/agent", { method: "POST", headers: H, body: JSON.stringify({ ...ask, tools: false, providerId: "import-evil" }), signal: AbortSignal.timeout(AGENT_TIMEOUT) });
const ct = r.headers.get("content-type") || "";
let buf = "";
let first = 0;
let chunks = 0;
if (r.body) {
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    let step;
    try {
      step = await reader.read();
    } catch (err) {
      check("/api/agent 流在时限内关闭", false, err && err.name);
      break;
    }
    const { done, value } = step;
    if (done) break;
    chunks++;
    if (!first) first = Date.now() - t0;
    buf += dec.decode(value, { stream: true });
  }
}
const events = buf.split("\n").filter(Boolean).map((line) => {
  try {
    return JSON.parse(line);
  } catch {
    return { type: "bad" };
  }
});
const types = events.map((event) => event.type);
check("/api/agent 返回 NDJSON 流", r.status === 200 && ct.includes("ndjson"), r.status + " " + ct);
check("/api/agent 以 done 结束（客户端传的 providerId 被忽略）", types[types.length - 1] === "done", types.join(",") + " " + JSON.stringify(events[events.length - 1] || {}));
check("/api/agent 有逐字 delta", types.includes("delta"), types.join(","));
check("/api/agent 流里不含密钥", clean(buf));
console.log("     agent: 首包 " + first + " ms, 总计 " + (Date.now() - t0) + " ms, " + chunks + " 个网络分块, " + events.length + " 个事件");

r = await fetch(BASE + "/api/search", { method: "POST", headers: H, body: JSON.stringify({ query: "锂电池 极片 专利", maxResults: 1 }) });
t = await r.text();
let searchBody = {};
try { searchBody = JSON.parse(t); } catch {}
check("/api/search 经服务端转发且返回检索结果", r.status === 200 && searchBody.ok === true && searchBody.results?.length > 0 && clean(t), t);

if (MOCK) {
  const seen = await (await fetch(MOCK_BASE + "/__seen")).json();
  check("上游收到 Worker 注入的模型密钥", seen.some((item) => item.path.includes("chat") && item.auth === "Bearer mock-model-key"));
  check("上游收到 Worker 注入的检索密钥", seen.some((item) => item.path.includes("search") && item.auth === "Bearer mock-search-key"));
  let limited = false;
  for (let i = 0; i < 10 && !limited; i++) {
    r = await fetch(BASE + "/api/chat", { method: "POST", headers: H, body: JSON.stringify(ask) });
    await r.text();
    limited = r.status === 429;
  }
  check("超过每小时次数 -> 429", limited);
}

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
