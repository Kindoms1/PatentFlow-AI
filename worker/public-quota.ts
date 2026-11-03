export type QuotaKind = 'model' | 'search';
interface QuotaStorage {
  transaction<T>(closure: (storage: { get<V>(key: string): Promise<V | undefined>; put(key: string, value: unknown): Promise<void> }) => Promise<T>): Promise<T>;
}
export interface QuotaNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
}
export interface PublicQuotaEnv {
  ACCESS_MODE?: string;
  PUBLIC_QUOTA?: QuotaNamespace;
  PUBLIC_DAILY_MODEL_CALLS?: string;
  PUBLIC_DAILY_SEARCH_CALLS?: string;
}
interface Usage { day: string; model: number; search: number }

export function quotaLimit(env: PublicQuotaEnv, kind: QuotaKind): number {
  const raw = kind === 'model' ? env.PUBLIC_DAILY_MODEL_CALLS : env.PUBLIC_DAILY_SEARCH_CALLS;
  const value = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) && value >= 0 ? Math.min(1_000_000, Math.floor(value)) : kind === 'model' ? 60 : 300;
}
export function quotaDay(now = Date.now()) {
  const shifted = new Date(now + 8 * 3600_000);
  return { day: shifted.toISOString().slice(0, 10), resetAt: new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() + 1) - 8 * 3600_000).toISOString() };
}
export function quotaMessage(kind: 'model' | 'search' | 'unavailable'): string {
  return kind === 'model' ? '本站今日共享模型调用额度已用完，北京时间零点重置；你仍可使用自己的模型 Key。'
    : kind === 'search' ? '本站今日共享检索调用额度已用完，北京时间零点重置。网页和已有文件仍可使用。'
    : '共享额度服务暂不可用，已暂停共享调用以保护额度。请稍后重试，或配置自己的模型 Key。';
}

/** One globally addressed Durable Object; no IP, user text or credential is stored. */
export class PublicQuota {
  private state: { storage: QuotaStorage };
  private env: PublicQuotaEnv;
  constructor(state: { storage: QuotaStorage }, env: PublicQuotaEnv) { this.state = state; this.env = env; }
  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/consume') return new Response('Not found', { status: 404 });
    const body = await request.json().catch(() => null) as { kind?: unknown } | null;
    if (body?.kind !== 'model' && body?.kind !== 'search') return new Response('Invalid request', { status: 400 });
    const kind = body.kind; const { day, resetAt } = quotaDay(); const limit = quotaLimit(this.env, kind);
    const result = await this.state.storage.transaction(async storage => {
      const previous = await storage.get<Usage>('usage');
      const usage = previous?.day === day ? previous : { day, model: 0, search: 0 };
      if (usage[kind] >= limit) return { allowed: false, remaining: 0, resetAt };
      usage[kind]++;
      await storage.put('usage', usage);
      return { allowed: true, remaining: limit - usage[kind], resetAt };
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  }
}

function denied(kind: QuotaKind | 'unavailable'): Response {
  const message = quotaMessage(kind);
  return Response.json({ error: { message }, message, code: kind === 'unavailable' ? 'PUBLIC_QUOTA_UNAVAILABLE' : 'PUBLIC_QUOTA_EXHAUSTED' }, {
    status: kind === 'unavailable' ? 503 : 429,
    headers: { 'X-PatentFlow-Quota': kind, 'Cache-Control': 'no-store' },
  });
}

/** Meter every actual shared upstream attempt, including agent tool calls and retries.
 * A user's BYOK model key is deliberately never passed as sharedModelSecret. */
export function quotaFetch(env: PublicQuotaEnv, sharedModelSecret?: string, searchSecret?: string): typeof fetch {
  return async (input, init) => {
    if (env.ACCESS_MODE === 'public') {
      const headers = new Headers(init?.headers);
      const owns = (key?: string) => Boolean(key && (headers.get('Authorization') === 'Bearer ' + key || headers.get('x-api-key') === key));
      const kinds: QuotaKind[] = [];
      if (owns(sharedModelSecret)) kinds.push('model');
      if (owns(searchSecret)) kinds.push('search');
      for (const kind of kinds) {
        if (!env.PUBLIC_QUOTA) return denied('unavailable');
        try {
          const stub = env.PUBLIC_QUOTA.get(env.PUBLIC_QUOTA.idFromName('shared-upstream-quota'));
          const response = await stub.fetch(new Request('https://quota.internal/consume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind }), signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) }));
          if (!response.ok) return denied('unavailable');
          const data = await response.json() as { allowed?: unknown };
          if (data.allowed === false) return denied(kind);
          if (data.allowed !== true) return denied('unavailable');
        } catch { return denied('unavailable'); }
      }
    }
    return fetch(input, init);
  };
}
