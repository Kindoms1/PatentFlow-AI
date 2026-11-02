import type { AuthStyle, ProviderProtocol } from "./provider-import.ts";

export interface CcSwitchEntry {
  key: string;
  name: string;
  app: string;
  appLabel: string;
  icon: string;
  iconColor: string;
  website: string;
  host: string;
  baseUrl: string;
  model: string;
  models: string[];
  hasKey: boolean;
  current: boolean;
  protocol: ProviderProtocol | "other";
  auth: AuthStyle;
  apiKey: string;
  canImport: boolean;
  reason: string;
}

const APP_LABEL: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  "claude-desktop": "Claude 桌面版",
  gemini: "Gemini",
  grokbuild: "Grok",
  opencode: "OpenCode",
  openclaw: "OpenClaw",
  hermes: "Hermes",
};

export function appLabel(app: string): string {
  return APP_LABEL[app] || app || "CC Switch";
}

export function parseCcSwitchRow(row: {
  id: string;
  app: string;
  name: string;
  icon: string;
  iconColor: string;
  website: string;
  current: boolean;
  settings: string;
}): CcSwitchEntry {
  const config = parseJson(row.settings);
  const env = record(config.env);
  const auth = record(config.auth);
  const toml = typeof config.config === "string" ? config.config : "";
  const baseUrl = firstUrl(
    envString(env, "ANTHROPIC_BASE_URL"),
    envString(env, "OPENAI_BASE_URL"),
    tomlValue(toml, "base_url"),
  );
  const catalog = catalogModels(config.modelCatalog);
  const configured = unique([
    tomlValue(toml, "model"),
    envString(env, "ANTHROPIC_MODEL"),
    envString(env, "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    envString(env, "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    envString(env, "OPENAI_MODEL"),
    ...catalog,
  ]);
  const apiKey = envString(auth, "OPENAI_API_KEY") || envString(env, "ANTHROPIC_API_KEY") || envString(env, "ANTHROPIC_AUTH_TOKEN") || envString(env, "OPENAI_API_KEY");
  const claude = Boolean(envString(env, "ANTHROPIC_API_KEY") || envString(env, "ANTHROPIC_AUTH_TOKEN") || envString(env, "ANTHROPIC_BASE_URL") || row.app.startsWith("claude"));
  const openai = Boolean(envString(auth, "OPENAI_API_KEY") || envString(env, "OPENAI_API_KEY") || baseUrl || row.app === "codex");
  const protocol: CcSwitchEntry["protocol"] = claude && !openai ? "claude" : openai ? "openai" : "other";
  const authStyle: AuthStyle = protocol === "claude" && envString(env, "ANTHROPIC_API_KEY") ? "x-api-key" : protocol === "claude" && envString(env, "ANTHROPIC_AUTH_TOKEN") ? "bearer" : protocol === "claude" ? "x-api-key" : "bearer";
  let reason = "";
  if (protocol === "other") reason = "这个厂家不是 OpenAI 或 Claude 协议，当前对话还不能直接用。";
  else if (!apiKey) reason = "CC Switch 里还没有这把密钥。";
  else if (!baseUrl) reason = "还没有接口地址。";
  const host = hostOf(row.website || baseUrl);
  return {
    key: `${row.app}:${row.id}`,
    name: row.name || "未命名提供方",
    app: row.app,
    appLabel: appLabel(row.app),
    icon: row.icon,
    iconColor: row.iconColor,
    website: row.website,
    host,
    baseUrl,
    model: configured[0] || "",
    models: configured,
    hasKey: Boolean(apiKey),
    current: row.current,
    protocol,
    auth: authStyle,
    apiKey,
    canImport: protocol !== "other" && Boolean(apiKey) && Boolean(baseUrl),
    reason,
  };
}

export function publicCcSwitch(entry: CcSwitchEntry): Omit<CcSwitchEntry, "apiKey" | "baseUrl"> {
  const { apiKey: _apiKey, baseUrl: _baseUrl, ...rest } = entry;
  return rest;
}

function catalogModels(value: unknown): string[] {
  const root = record(value);
  const models = Array.isArray(root.models) ? root.models : [];
  return models.flatMap((item) => {
    const row = record(item);
    const name = envString(row, "model") || envString(row, "slug") || envString(row, "displayName");
    return name ? [name] : [];
  });
}

function tomlValue(text: string, key: string): string {
  const match = new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]+)"`).exec(text);
  return match?.[1]?.trim() || "";
}

function firstUrl(...values: string[]): string {
  return values.find((item) => item.startsWith("http")) || "";
}

function hostOf(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return "";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function parseJson(raw: string): Record<string, unknown> {
  try {
    const value = JSON.parse(raw) as unknown;
    return record(value);
  } catch {
    return {};
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function envString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}
