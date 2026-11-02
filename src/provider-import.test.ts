import assert from "node:assert/strict";
import { parseProviderImport } from "./provider-import.ts";

const claude = parseProviderImport(`{
  "name": "desk",
  "env": { "ANTHROPIC_API_KEY": "sk-test-claude", "ANTHROPIC_BASE_URL": "https://claude.example/v1", "ANTHROPIC_MODEL": "claude-sonnet" }
}`);
assert.equal(claude.providers.length, 1);
assert.equal(claude.providers[0]?.protocol, "claude");
assert.equal(claude.providers[0]?.auth, "x-api-key");
assert.equal(claude.providers[0]?.model, "claude-sonnet");

const openai = parseProviderImport(`{ "OPENAI_API_KEY": "sk-test-openai", "OPENAI_BASE_URL": "https://api.example/v1", "model": "gpt-test" }`);
assert.equal(openai.providers[0]?.protocol, "openai");
assert.equal(openai.providers[0]?.auth, "bearer");

const link = parseProviderImport("ccswitch://v1/import?resource=provider&app=codex&name=gateway&endpoint=https://gate.example/v1&apiKey=sk-link&apiFormat=openai_chat&model=demo-model");
assert.equal(link.providers[0]?.name, "gateway");
assert.equal(link.providers[0]?.protocol, "openai");
assert.equal(link.providers[0]?.baseUrl, "https://gate.example/v1");

const both = parseProviderImport(`{
  "providers": [
    { "name": "oa", "protocol": "openai", "baseUrl": "https://oa.example/v1", "apiKey": "sk-a", "model": "m1" },
    { "name": "cl", "protocol": "claude", "baseUrl": "https://cl.example", "apiKey": "sk-b", "model": "m2" }
  ]
}`);
assert.deepEqual(both.providers.map((item) => item.protocol), ["openai", "claude"]);

const toml = parseProviderImport(`
model = "gpt-5.6-sol"
[model_providers.custom]
base_url = "https://toml.example/v1"
`);
assert.equal(toml.providers[0]?.baseUrl, "https://toml.example/v1");
assert.equal(toml.providers[0]?.protocol, "openai");

const bad = parseProviderImport("你好");
assert.equal(bad.providers.length, 0);
assert.ok(bad.error);

const wrapped = parseProviderImport(`请导入下面这段：
{
  "name": "desk",
  "env": { "ANTHROPIC_API_KEY": "sk-wrap", "ANTHROPIC_BASE_URL": "https://wrap.example/v1", "ANTHROPIC_MODEL": "sonnet" }
}`);
assert.equal(wrapped.providers[0]?.apiKey, "sk-wrap");
assert.equal(wrapped.providers[0]?.protocol, "claude");

const sonnet = parseProviderImport("ccswitch://v1/import?resource=provider&app=claude&name=desk&endpoint=https://api.example/v1&apiKey=sk-sonnet&sonnetModel=claude-sonnet-4");
assert.equal(sonnet.providers[0]?.protocol, "claude");
assert.equal(sonnet.providers[0]?.model, "claude-sonnet-4");

const payload = Buffer.from(JSON.stringify({
  env: { ANTHROPIC_API_KEY: "sk-cfg", ANTHROPIC_BASE_URL: "https://cfg.example/v1", ANTHROPIC_MODEL: "haiku" },
}), "utf8").toString("base64");
const coded = parseProviderImport(`ccswitch://v1/import?resource=provider&app=claude&name=coded&config=${payload}`);
assert.equal(coded.providers[0]?.apiKey, "sk-cfg");
assert.equal(coded.providers[0]?.baseUrl, "https://cfg.example/v1");

const many = parseProviderImport(`
ccswitch://v1/import?resource=provider&app=codex&name=one&endpoint=https://one.example/v1&apiKey=sk-1&apiFormat=openai_chat&model=m1
ccswitch://v1/import?resource=provider&app=claude&name=two&endpoint=https://two.example/v1&apiKey=sk-2&model=m2
`);
assert.equal(many.providers.length, 2);
assert.deepEqual(many.providers.map((item) => item.protocol).sort(), ["claude", "openai"]);

console.log("provider import checks passed");
