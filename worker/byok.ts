import { MODEL_HOSTS } from '../src/model-presets.ts';
import type { RouteProvider } from '../server/agent-routes.ts';

export interface ByokEnv { BYOK_ALLOWED_HOSTS?: string; BYOK_ENABLED?: string }
export type ByokProvider = RouteProvider & { maxOutputTokens: number };

function publicHostname(value: string): boolean {
  return value.length <= 253 && /^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(value)
    && !/(?:^|\.)(?:localhost|local|internal|lan|test|invalid|home|arpa)$/.test(value);
}

export function byokHosts(env: ByokEnv): string[] {
  return [...new Set([...MODEL_HOSTS, ...(env.BYOK_ALLOWED_HOSTS || '').toLowerCase().split(/[,\s]+/).filter(publicHostname)])];
}

/** Only the caller's own credentials can be paired with a caller-selected URL.
 * Custom hosts require explicit operator trust; no wildcard/IP/private endpoints or redirects. */
export function parseByok(value: unknown, env: ByokEnv, allowEmptyModel = false): ByokProvider | string {
  if (env.BYOK_ENABLED === 'false') return '本站暂未开放自带模型。';
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '请先填写自己的模型配置。';
  const input = value as Record<string, unknown>;
  const text = (key: string) => typeof input[key] === 'string' ? (input[key] as string).trim() : '';
  const name = text('name') || '我的模型';
  const model = text('model') || (allowEmptyModel ? '__model_list__' : '');
  const secret = text('apiKey');
  const baseUrl = text('baseUrl');
  if (!model || model.length > 256 || /[\r\n\x00-\x1f]/.test(model)) return '请填写有效的模型 ID（不是网站名称）。';
  if (name.length > 80 || /[\r\n\x00-\x1f]/.test(name)) return '模型名称过长或含无效字符。';
  if (secret.length < 8 || secret.length > 2048 || /[^\x21-\x7e]/.test(secret)) return '请填写有效的 API Key，不要包含空格或换行。';
  if (name.includes(secret) || model.includes(secret) || baseUrl.includes(secret)) return '密钥只能填写在 API Key 字段。';
  if (input.protocol !== 'openai' && input.protocol !== 'claude') return '请选择 OpenAI 兼容或 Anthropic Messages 协议。';
  let url: URL;
  try { url = new URL(baseUrl); } catch { return '接口地址不是有效的 HTTPS 地址。'; }
  if (baseUrl.length > 500 || url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || !publicHostname(url.hostname)) return '仅支持无账号、查询参数或自定义端口的公网 HTTPS 接口地址。';
  if (!byokHosts(env).includes(url.hostname)) return '该服务域名尚未开放。请联系管理员加入 BYOK_ALLOWED_HOSTS，不要改填其他服务的密钥。';
  const limit = input.maxOutputTokens ?? 32000;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 256 || limit > 32000) return '单次输出上限应为 256–32000 tokens。';
  const tokenParameter = input.tokenParameter ?? 'auto';
  if (!['auto', 'max_tokens', 'max_completion_tokens'].includes(String(tokenParameter))) return '输出参数不受支持。';
  return { id: 'byok', name, protocol: input.protocol, role: 'model', baseUrl: url.href.replace(/\/$/, ''), model, secret, auth: input.protocol === 'claude' ? 'x-api-key' : 'bearer', maxOutputTokens: limit, tokenParameter: tokenParameter as 'auto' | 'max_tokens' | 'max_completion_tokens' };
}
