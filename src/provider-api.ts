export interface PublicProvider {
  id: string;
  name: string;
  protocol: "openai" | "claude";
  role: "model" | "search";
  baseUrl: string;
  website: string;
  model: string;
  models?: string[];
  icon?: string;
  iconColor?: string;
  hasKey: boolean;
  keyHint: string;
  active: boolean;
}

export interface CcLocalProvider {
  key: string;
  name: string;
  app: string;
  appLabel: string;
  icon: string;
  iconColor: string;
  website: string;
  host: string;
  model: string;
  models: string[];
  hasKey: boolean;
  current: boolean;
  protocol: "openai" | "claude" | "other";
  canImport: boolean;
  reason: string;
}

interface ProviderResponse {
  providers?: PublicProvider[];
  error?: string;
  imported?: number;
}

export async function listProviders(): Promise<PublicProvider[]> {
  const response = await fetch("/api/providers");
  if (!response.ok) return [];
  const body = (await response.json()) as ProviderResponse;
  return body.providers ?? [];
}

export async function listCcSwitch(): Promise<{ providers: CcLocalProvider[]; detail: string }> {
  const response = await fetch("/api/ccswitch");
  if (!response.ok) return { providers: [], detail: "没有读到 CC Switch 配置。" };
  const body = (await response.json()) as { providers?: CcLocalProvider[]; detail?: string };
  return { providers: body.providers ?? [], detail: body.detail || "" };
}

export async function importCcSwitch(key: string, model: string): Promise<ProviderResponse> {
  const response = await fetch("/api/ccswitch/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, model }),
  });
  const body = (await response.json()) as ProviderResponse;
  if (!response.ok) return { error: body.error || "没有从 CC Switch 导入。" };
  return body;
}

export async function selectProviderModel(id: string, model: string): Promise<void> {
  await fetch("/api/providers/model", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, model }),
  });
}

export async function importProviderText(text: string): Promise<ProviderResponse> {
  const response = await fetch("/api/providers/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = (await response.json()) as ProviderResponse;
  if (!response.ok) return { error: body.error || "导入没有完成。" };
  return body;
}

export async function removeProvider(id: string): Promise<void> {
  await fetch("/api/providers/remove", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function activateProvider(id: string): Promise<void> {
  await fetch("/api/providers/activate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function testProvider(id: string): Promise<{ ok: boolean; status: number; detail: string }> {
  const response = await fetch("/api/providers/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  return (await response.json()) as { ok: boolean; status: number; detail: string };
}

export async function addProvider(input: { name: string; protocol: "openai" | "claude"; baseUrl: string; model: string; apiKey: string }): Promise<string | null> {
  const response = await fetch("/api/providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = (await response.json()) as ProviderResponse;
  return body.error || null;
}

export async function chatWithModel(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, signal?: AbortSignal): Promise<{ ok: boolean; text: string; detail: string; model: string }> {
  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
      signal,
    });
    const body = (await response.json()) as { ok?: boolean; text?: string; detail?: string; model?: string; error?: string };
    return {
      ok: Boolean(body.ok),
      text: body.text || "",
      detail: body.detail || body.error || "模型没有返回内容。",
      model: body.model || "",
    };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return { ok: false, text: "", detail: "已停止。", model: "" };
    }
    return { ok: false, text: "", detail: "没有连上模型服务。", model: "" };
  }
}

export interface SearchLead {
  title: string;
  url: string;
  snippet: string;
}

export async function searchAny(query: string, zone?: "cn" | "intl"): Promise<{ ok: boolean; status: number; detail: string; results: SearchLead[] }> {
  try {
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(zone ? { query, zone } : { query }),
    });
    const body = (await response.json()) as { ok?: boolean; status?: number; detail?: string; error?: string; results?: Array<{ title?: string; url?: string; snippet?: string }> };
    return {
      ok: Boolean(body.ok),
      status: body.status ?? response.status,
      detail: body.detail || body.error || "检索没有完成。",
      results: (body.results ?? []).map((item) => ({ title: item.title || "", url: item.url || "", snippet: item.snippet || "" })),
    };
  } catch {
    return { ok: false, status: 0, detail: "没有连上检索服务。", results: [] };
  }
}

export async function extractAny(url: string): Promise<{ ok: boolean; title: string; content: string; detail: string }> {
  try {
    const response = await fetch("/api/extract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = (await response.json()) as { ok?: boolean; title?: string; content?: string; detail?: string; error?: string };
    return { ok: Boolean(body.ok), title: body.title || "", content: body.content || "", detail: body.detail || body.error || "" };
  } catch {
    return { ok: false, title: "", content: "", detail: "没有连上检索服务。" };
  }
}

export interface RadarApiHit {
  pn: string;
  kind: string;
  title: string;
  url: string;
  sourceUrl: string;
  snippet: string;
  topicId: string;
  query: string;
  foundAt: string;
}

export interface RadarApiRun {
  ok: boolean;
  detail: string;
  topicId: string;
  ranAt: string;
  queries: string[];
  hits: RadarApiHit[];
  skippedSeen: number;
  errors: string[];
}

export async function runRadarApi(input: { topic: { id: string; name: string; keywords: string[]; ipc?: string }; seen: string[] }): Promise<RadarApiRun> {
  const failed = (detail: string): RadarApiRun => ({ ok: false, detail, topicId: input.topic.id, ranAt: new Date().toISOString(), queries: [], hits: [], skippedSeen: 0, errors: [detail] });
  try {
    const response = await fetch("/api/radar/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = (await response.json()) as Partial<RadarApiRun> & { error?: string };
    if (!response.ok && !body.detail) return failed(body.error || `专利雷达返回 ${response.status}`);
    return {
      ok: Boolean(body.ok),
      detail: body.detail || body.error || "",
      topicId: body.topicId || input.topic.id,
      ranAt: body.ranAt || new Date().toISOString(),
      queries: body.queries ?? [],
      hits: body.hits ?? [],
      skippedSeen: body.skippedSeen ?? 0,
      errors: body.errors ?? [],
    };
  } catch {
    return failed("暂时连不上服务，请稍后重试。");
  }
}
