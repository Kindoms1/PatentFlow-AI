// Writes .dev.vars for "wrangler dev" from .env.local. Never prints a key.
// node scripts/cf-dev-vars.mjs          real upstream (keys from .env.local)
// node scripts/cf-dev-vars.mjs --mock   mock upstream on 127.0.0.1:8789 (scripts/mock-llm.mjs)
import fs from "node:fs";
import crypto from "node:crypto";

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

const mock = process.argv.includes("--mock");
const env = parse(".env.local");
const prev = parse(".dev.vars");
const out = {
  ACCESS_MODE: mock ? 'invite' : env.ACCESS_MODE || 'public',
  SESSION_SECRET: prev.SESSION_SECRET || crypto.randomBytes(32).toString("hex"),
};
if (out.ACCESS_MODE === 'invite') out.ACCESS_CODES = prev.ACCESS_CODES || 'pf-' + crypto.randomBytes(6).toString('hex');
if (mock) {
  Object.assign(out, {
    AGNES_API_KEY: "mock-model-key",
    AGNES_BASE_URL: "http://127.0.0.1:8789/v1",
    AGNES_MODEL: "mock-model",
    ANYSEARCH_API_KEY: "mock-search-key",
    ANYSEARCH_BASE_URL: "http://127.0.0.1:8789",
    AGENT_PER_HOUR: "8",
  });
} else {
  for (const key of ["AGNES_API_KEY", "AGNES_BASE_URL", "AGNES_MODEL", "AGNES_WEBSITE", "ANYSEARCH_API_KEY", "ANYSEARCH_BASE_URL", "ANYSEARCH_WEBSITE"]) {
    if (env[key]) out[key] = env[key];
  }
}
fs.writeFileSync(".dev.vars", Object.entries(out).map(([key, value]) => key + '="' + value + '"').join("\n") + "\n");
console.log("wrote .dev.vars (" + (mock ? "mock" : "real") + " upstream), keys: " + Object.keys(out).join(", "));
