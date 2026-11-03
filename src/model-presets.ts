export type ModelProtocol = 'openai' | 'claude';
export type TokenParameter = 'auto' | 'max_tokens' | 'max_completion_tokens';

export interface PersonalModelInput {
  name: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
  maxOutputTokens: number;
  tokenParameter: TokenParameter;
}

/** These are connection templates, not claims that every model has been tested. */
export const MODEL_PRESETS = [
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'agnes', name: 'Agnes', protocol: 'openai', baseUrl: 'https://apihub.agnes-ai.com/v1' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic / Claude', protocol: 'claude', baseUrl: 'https://api.anthropic.com/v1' },
  { id: 'gemini', name: 'Google Gemini（OpenAI 兼容）', protocol: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  { id: 'qwen', name: '通义千问 / 百炼', protocol: 'openai', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { id: 'moonshot', name: 'Moonshot / Kimi', protocol: 'openai', baseUrl: 'https://api.moonshot.cn/v1' },
  { id: 'glm', name: '智谱 GLM', protocol: 'openai', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { id: 'siliconflow', name: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
  { id: 'custom', name: '其他兼容服务 / 自定义', protocol: 'openai', baseUrl: '' },
] as const;

export const MODEL_HOSTS = [...new Set(MODEL_PRESETS.filter(item => item.baseUrl).map(item => new URL(item.baseUrl).hostname)),
  'dashscope-intl.aliyuncs.com', 'dashscope-us.aliyuncs.com', 'api.moonshot.ai',
  'api.siliconflow.com', 'api.x.ai', 'api.groq.com', 'api.mistral.ai',
  'ark.cn-beijing.volces.com', 'api.minimax.io', 'api.minimaxi.com',
  'api.hunyuan.cloud.tencent.com', 'api.baichuan-ai.com'];
