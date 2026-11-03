// Pushes explicitly prepared production secrets (run after "npx wrangler login"). Never prints a model/search key.
// Public mode is the default. --codes is only for an explicitly invite-only deployment.
// Re-running rotates SESSION_SECRET, which signs everyone out.
import fs from "node:fs";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function parse(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const source = ".env.production.local";
if (!fs.existsSync(source)) {
  console.error("缺少 .env.production.local。请单独配置正式服务密钥；不会读取或上传本地测试密钥。");
  process.exit(1);
}
const env = parse(source);
const required = ["AGNES_API_KEY", "AGNES_BASE_URL", "AGNES_MODEL", "ANYSEARCH_API_KEY"];
const missing = required.filter((key) => !env[key]);
if (missing.length) {
  console.error("正式配置缺少：" + missing.join(", "));
  process.exit(1);
}
const at = process.argv.indexOf("--codes");
const invite = env.ACCESS_MODE === 'invite' || at > -1;
const codes = invite ? at > -1 && process.argv[at + 1] ? process.argv[at + 1] : Array.from({ length: 3 }, () => 'pf-' + crypto.randomBytes(6).toString('hex')).join(',') : '';
const secrets = { SESSION_SECRET: env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'), ...(invite ? { ACCESS_CODES: codes } : {}) };
for (const key of ["AGNES_API_KEY", "AGNES_BASE_URL", "AGNES_MODEL", "AGNES_WEBSITE", "ANYSEARCH_API_KEY", "ANYSEARCH_BASE_URL", "ANYSEARCH_WEBSITE"]) {
  if (env[key]) secrets[key] = env[key];
}
for (const [key, value] of Object.entries(secrets)) {
  const run = spawnSync("npx", ["wrangler", "secret", "put", key], { input: value, stdio: ["pipe", "inherit", "inherit"], shell: process.platform === "win32" });
  if (run.status !== 0) {
    console.error("写入失败：" + key);
    process.exit(1);
  }
}
if (invite) fs.writeFileSync('.env.access.production.local', 'ACCESS_CODES=' + JSON.stringify(codes) + '\n');
console.log('已写入 ' + Object.keys(secrets).length + ' 个 secret。' + (invite ? '邀请码仅保存在 .env.access.production.local；部署时须显式设置 ACCESS_MODE=invite。' : '公开模式无需邀请码，保留公告确认。'));
