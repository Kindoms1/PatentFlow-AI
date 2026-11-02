export type ProviderProtocol = "openai" | "claude";
export type AuthStyle = "bearer" | "x-api-key";

export interface ImportedProvider {
  name: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  website: string;
  auth: AuthStyle;
}

export interface ImportResult {
  providers: ImportedProvider[];
  error?: string;
}

export function parseProviderImport(raw: string): ImportResult {
  const text = raw.trim();
  if (!text) return { providers: [], error: "没有可导入的内容。" };
  const found: ImportedProvider[] = [];
  for (const link of text.match(/ccswitch:\/\/[^\s<>"']+/g) ?? []) {
    const provider = parseDeepLink(link);
    if (provider) found.push(provider);
  }
  try {
    found.push(...fromJson(JSON.parse(text)));
  } catch {
    for (const blob of extractJsonObjects(text)) {
      if (looksLikeProvider(blob)) found.push(...fromJson(blob));
    }
  }
  const tomlProvider = parseToml(text);
  if (tomlProvider) found.push(tomlProvider);
  const providers = dedupe(found).filter((item) => item.apiKey || item.baseUrl);
  if (providers.length === 0) {
    return { providers: [], error: "没有认出 OpenAI 或 Claude 的接口、密钥或模型。可粘贴 CC Switch 的 JSON、ccswitch:// 链接，或 Codex 的 config.toml。" };
  }
  return { providers };
}

function fromJson(value: unknown): ImportedProvider[] {
  if (Array.isArray(value)) return value.flatMap((item) => fromJson(item));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const found: ImportedProvider[] = [];
  if (Array.isArray(record.providers)) found.push(...record.providers.flatMap((item) => fromJson(item)));
  const env = asRecord(record.env);
  const name = stringValue(record.name) || stringValue(record.providerName);
  const claudeKey = stringValue(env?.ANTHROPIC_API_KEY);
  const claudeToken = stringValue(env?.ANTHROPIC_AUTH_TOKEN);
  const claudeBase = stringValue(env?.ANTHROPIC_BASE_URL);
  const claudeModel = stringValue(env?.ANTHROPIC_MODEL) || stringValue(env?.ANTHROPIC_DEFAULT_SONNET_MODEL) || stringValue(env?.ANTHROPIC_DEFAULT_OPUS_MODEL) || stringValue(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL);
  if (claudeKey || claudeToken || claudeBase) {
    found.push({
      name: name || "Claude 提供方",
      protocol: "claude",
      baseUrl: claudeBase,
      model: claudeModel,
      apiKey: claudeKey || claudeToken,
      website: "",
      auth: claudeKey ? "x-api-key" : "bearer",
    });
  }
  const openaiKey = stringValue(env?.OPENAI_API_KEY) || stringValue(record.OPENAI_API_KEY);
  const openaiBase = stringValue(env?.OPENAI_BASE_URL) || stringValue(record.OPENAI_BASE_URL);
  const openaiModel = stringValue(env?.OPENAI_MODEL) || stringValue(record.OPENAI_MODEL) || stringValue(record.model);
  if (openaiKey || openaiBase) {
    found.push({
      name: name && !claudeKey && !claudeToken ? name : "OpenAI 提供方",
      protocol: "openai",
      baseUrl: openaiBase,
      model: openaiModel,
      apiKey: openaiKey,
      website: "",
      auth: "bearer",
    });
  }
  const auth = asRecord(record.auth);
  if (auth) found.push(...fromJson(auth));
  if (typeof record.config === "string") {
    const nested = parseToml(record.config);
    if (nested) found.push(nested);
  }
  const directKey = stringValue(record.apiKey) || stringValue(record.api_key);
  const directBase = stringValue(record.endpoint) || stringValue(record.baseUrl) || stringValue(record.base_url);
  const format = `${stringValue(record.apiFormat) || stringValue(record.protocol) || stringValue(record.app)}`.toLowerCase();
  if (directKey || directBase) {
    const protocol: ProviderProtocol = format.includes("claude") || format.includes("anthropic") ? "claude" : format.includes("openai") || format.includes("codex") ? "openai" : directBase.includes("anthropic") ? "claude" : "openai";
    found.push({
      name: name || (protocol === "claude" ? "Claude 提供方" : "OpenAI 提供方"),
      protocol,
      baseUrl: firstEndpoint(directBase),
      model: stringValue(record.model) || stringValue(record.modelId) || stringValue(record.sonnetModel),
      apiKey: directKey,
      website: stringValue(record.homepage) || stringValue(record.website),
      auth: protocol === "claude" ? "x-api-key" : "bearer",
    });
  }
  return found.filter((item) => item.apiKey || item.baseUrl || item.model);
}

function parseDeepLink(text: string): ImportedProvider | null {
  let url: URL;
  try {
    url = new URL(text.replace(/^ccswitch:\/\//, "https://ccswitch.local/"));
  } catch {
    return null;
  }
  const params = url.searchParams;
  const resource = params.get("resource");
  if (resource && resource !== "provider") return null;
  const format = `${params.get("apiFormat") || ""} ${params.get("app") || ""}`.toLowerCase();
  if (format.includes("gemini") && !format.includes("openai")) return null;
  const extra = params.get("config") ? providerFromConfig(params.get("config") || "", params.get("configFormat")) : null;
  const protocol: ProviderProtocol = format.includes("openai") || format.includes("codex") ? "openai" : extra?.protocol === "openai" && !format.includes("claude") && !format.includes("anthropic") ? "openai" : "claude";
  const provider: ImportedProvider = {
    name: params.get("name") || extra?.name || "导入的提供方",
    protocol,
    baseUrl: firstEndpoint(params.get("endpoint") || "") || extra?.baseUrl || "",
    model: params.get("model") || params.get("sonnetModel") || params.get("opusModel") || params.get("haikuModel") || extra?.model || "",
    apiKey: params.get("apiKey") || extra?.apiKey || "",
    website: params.get("homepage") || extra?.website || "",
    auth: protocol === "claude" ? "x-api-key" : "bearer",
  };
  if (!provider.apiKey && !provider.baseUrl && !provider.model) return null;
  return provider;
}

function providerFromConfig(raw: string, format: string | null): ImportedProvider | null {
  const decoded = decodeBase64(raw);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded) as unknown;
    const items = fromJson(parsed);
    if (items[0]) return items[0];
  } catch {
    /* toml or plain text */
  }
  if ((format || "").toLowerCase() === "toml" || decoded.includes("base_url")) {
    return parseToml(decoded);
  }
  return null;
}

function parseToml(text: string): ImportedProvider | null {
  const base = /base_url\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? "";
  const model = /(?:^|\n)\s*model\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? "";
  const key = /(?:OPENAI_API_KEY|api_key)\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? "";
  if (!base && !model && !key) return null;
  return { name: "OpenAI 提供方", protocol: "openai", baseUrl: base, model, apiKey: key, website: "", auth: "bearer" };
}

function extractJsonObjects(text: string): unknown[] {
  const results: unknown[] = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let cursor = index; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (inString) {
        if (escape) escape = false;
        else if (char === "\\") escape = true;
        else if (char === "\"") inString = false;
        continue;
      }
      if (char === "\"") inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            results.push(JSON.parse(text.slice(index, cursor + 1)));
          } catch {
            /* skip */
          }
          index = cursor;
          break;
        }
      }
    }
  }
  return results;
}

function looksLikeProvider(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (Array.isArray(record.providers)) return true;
  if (asRecord(record.env)) return true;
  return Boolean(record.OPENAI_API_KEY || record.ANTHROPIC_API_KEY || record.apiKey || record.api_key || record.endpoint || record.baseUrl || record.base_url);
}

function decodeBase64(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  try {
    if (typeof atob === "function") return atob(normalized);
  } catch {
    /* Node fallback */
  }
  return Buffer.from(normalized, "base64").toString("utf8");
}

function firstEndpoint(value: string): string {
  return value.split(",")[0]?.trim() ?? "";
}

function dedupe(items: ImportedProvider[]): ImportedProvider[] {
  const seen = new Set<string>();
  const result: ImportedProvider[] = [];
  for (const item of items) {
    const key = `${item.protocol}|${item.name}|${item.baseUrl}|${item.model}|${item.apiKey.slice(-4)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
