import assert from "node:assert/strict";
import { parseCcSwitchRow, publicCcSwitch } from "./ccswitch-parse.ts";

const deepseek = parseCcSwitchRow({
  id: "deep",
  app: "codex",
  name: "DeepSeek",
  icon: "deepseek",
  iconColor: "#1E88E5",
  website: "https://platform.deepseek.com",
  current: true,
  settings: JSON.stringify({
    auth: { OPENAI_API_KEY: "sk-secret-value" },
    config: 'model = "deepseek-v4-flash"\nbase_url = "https://api.example/v1"\n',
    modelCatalog: { models: [{ model: "deepseek-v4-flash" }, { model: "deepseek-v4-pro" }] },
  }),
});

assert.equal(deepseek.protocol, "openai");
assert.equal(deepseek.model, "deepseek-v4-flash");
assert.deepEqual(deepseek.models, ["deepseek-v4-flash", "deepseek-v4-pro"]);
assert.equal(deepseek.canImport, true);
assert.equal(deepseek.apiKey, "sk-secret-value");
assert.equal("apiKey" in publicCcSwitch(deepseek), false);

const official = parseCcSwitchRow({
  id: "claude-official",
  app: "claude",
  name: "Claude Official",
  icon: "anthropic",
  iconColor: "#D4915D",
  website: "https://www.anthropic.com/claude-code",
  current: false,
  settings: JSON.stringify({ env: {} }),
});
assert.equal(official.canImport, false);
assert.match(official.reason, /密钥/);

console.log("ccswitch parse checks passed");
