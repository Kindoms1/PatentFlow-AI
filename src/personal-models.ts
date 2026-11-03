import type { PersonalModelInput } from './model-presets.ts';

export const PERSONAL_MODELS_CHANGED = 'patentflow-personal-models-changed';
const CONFIG_KEY = 'patentflow.personal-models.v1';
const SESSION_KEY = 'patentflow.personal-model-keys.v1';
export class PersonalModelError extends Error {}
export interface PersonalModel extends Omit<PersonalModelInput, 'apiKey'> { id: string; rememberSession: boolean; hasKey: boolean; active: boolean }
type StoredModel = Omit<PersonalModel, 'hasKey' | 'active'>;
type StoragePort = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };
export interface ModelSelection { clientProvider?: PersonalModelInput }
function parse(text: string | null): Record<string, unknown> {
  try { const value = JSON.parse(text || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; }
}

/** Secret values never enter the workspace, audit exports or persistent localStorage. */
export function createPersonalModels(local?: StoragePort, session?: StoragePort, changed: () => void = () => {}) {
  let warning = '';
  const read = (storage: StoragePort | undefined, key: string) => { try { return storage?.getItem(key) || null; } catch { warning = '浏览器不允许保存配置，本次仅在内存中使用。'; return null; } };
  const saved = parse(read(local, CONFIG_KEY));
  let profiles: StoredModel[] = Array.isArray(saved.profiles) ? saved.profiles.filter((v): v is StoredModel => !!v && typeof v === 'object' && typeof v.id === 'string' && v.id.startsWith('personal-')).map(v => ({ id: v.id, name: String(v.name || ''), protocol: v.protocol === 'claude' ? 'claude' : 'openai', baseUrl: String(v.baseUrl || ''), model: String(v.model || ''), maxOutputTokens: Number(v.maxOutputTokens) || 32000, tokenParameter: v.tokenParameter === 'max_tokens' || v.tokenParameter === 'max_completion_tokens' ? v.tokenParameter : 'auto', rememberSession: Boolean(v.rememberSession) })) : [];
  let active = typeof saved.active === 'string' && profiles.some(v => v.id === saved.active) ? saved.active : '';
  const restored = parse(read(session, SESSION_KEY));
  const keys = new Map(profiles.filter(v => v.rememberSession && typeof restored[v.id] === 'string').map(v => [v.id, restored[v.id] as string]));
  const persist = () => {
    try {
    local?.setItem(CONFIG_KEY, JSON.stringify({ profiles, active }));
    const remembered = Object.fromEntries(profiles.filter(v => v.rememberSession && keys.has(v.id)).map(v => [v.id, keys.get(v.id)]));
    if (Object.keys(remembered).length) session?.setItem(SESSION_KEY, JSON.stringify(remembered));
    else session?.removeItem(SESSION_KEY);
    } catch { warning = '浏览器未能保存配置或 Key，本次可用，刷新后请重新填写。'; }
    changed();
  };
  return {
    warning: () => warning,
    list(): PersonalModel[] { return profiles.map(v => ({ ...v, hasKey: keys.has(v.id), active: active === v.id })); },
    save(input: PersonalModelInput, rememberSession: boolean, id?: string): string {
      const previous = profiles.find(v => v.id === id);
      const sameService = previous?.baseUrl === input.baseUrl.trim() && previous?.protocol === input.protocol;
      const key = input.apiKey.trim() || (id && sameService ? keys.get(id) : '') || '';
      if (!input.name.trim() || !input.model.trim() || !input.baseUrl.trim() || !key) throw new Error('请填写名称、接口地址、模型 ID 和 API Key。');
      if ([input.name, input.model, input.baseUrl].some(v => v.includes(key))) throw new Error('密钥只能填写在 API Key 字段。');
      const target = id || 'personal-' + crypto.randomUUID();
      const profile: StoredModel = { id: target, name: input.name.trim(), protocol: input.protocol, baseUrl: input.baseUrl.trim(), model: input.model.trim(), maxOutputTokens: input.maxOutputTokens, tokenParameter: input.tokenParameter, rememberSession };
      profiles = [...profiles.filter(v => v.id !== target), profile];
      keys.set(target, key); active = target; persist(); return target;
    },
    use(id = '') { if (id && !profiles.some(v => v.id === id)) throw new Error('模型配置不存在。'); active = id; persist(); },
    remove(id: string) { profiles = profiles.filter(v => v.id !== id); keys.delete(id); if (active === id) active = ''; persist(); },
    request(id = active): PersonalModelInput | undefined {
      if (!id) return undefined;
      const profile = profiles.find(v => v.id === id);
      if (!profile) throw new PersonalModelError('选中的个人模型已不存在，请重新选择。');
      const apiKey = keys.get(id);
      if (!apiKey) throw new PersonalModelError('当前个人模型需要重新填写 API Key，请打开模型设置；不会自动改用站点额度。');
      const { name, protocol, baseUrl, model, maxOutputTokens, tokenParameter } = profile;
      return { name, protocol, baseUrl, model, maxOutputTokens, tokenParameter, apiKey };
    },
  };
}

let instance: ReturnType<typeof createPersonalModels> | undefined;
export function personalModels() {
  if (!instance) {
    let local: StoragePort | undefined; let session: StoragePort | undefined;
    const host = globalThis as typeof globalThis & { localStorage?: StoragePort; sessionStorage?: StoragePort; dispatchEvent?: (event: Event) => boolean };
    try { local = host.localStorage; session = host.sessionStorage; } catch { /* Privacy mode: memory-only configuration. */ }
    instance = createPersonalModels(local, session, () => { host.dispatchEvent?.(new Event(PERSONAL_MODELS_CHANGED)); });
  }
  return instance;
}

export function withPersonalModel<T extends object>(body: T): T & { clientProvider?: PersonalModelInput } {
  const clientProvider = personalModels().request();
  return clientProvider ? { ...body, clientProvider } : body;
}
