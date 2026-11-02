export const VENDOR_FILE: Record<string, string> = {
  openai: "openai.svg",
  anthropic: "anthropic.svg",
  claude: "claude.svg",
  gemini: "gemini.svg",
  grok: "grok.svg",
  xai: "xai.svg",
  deepseek: "deepseek.svg",
  qwen: "qwen.svg",
  kimi: "kimi.svg",
  zhipu: "zhipu.svg",
  minimax: "minimax.svg",
  doubao: "doubao.svg",
  meta: "meta.svg",
  mistral: "mistral.svg",
  ollama: "ollama.svg",
  openrouter: "openrouter.svg",
  google: "google.svg",
  azure: "azure.svg",
  newapi: "newapi.svg",
  siliconflow: "siliconflow.svg",
  baidu: "baidu.svg",
  huawei: "huawei.svg",
  bytedance: "bytedance.svg",
  stepfun: "stepfun.svg",
  copilot: "copilot.svg",
  huoshan: "huoshan.png",
};

export const VENDOR_COLOR: Record<string, string> = {
  openai: "#00A67E",
  anthropic: "#D4915D",
  claude: "#D4915D",
  gemini: "#4285F4",
  grok: "#111111",
  xai: "#111111",
  deepseek: "#1E88E5",
  qwen: "#615CED",
  kimi: "#000000",
  zhipu: "#3859FF",
  minimax: "#F23F5D",
  doubao: "#3370FF",
  meta: "#0668E1",
  mistral: "#FA520F",
  ollama: "#000000",
  openrouter: "#6566F1",
  google: "#4285F4",
  azure: "#0078D4",
  newapi: "#4F46E5",
  siliconflow: "#6C5CE7",
  baidu: "#2932E1",
  huawei: "#CF0A2C",
  bytedance: "#3370FF",
  stepfun: "#111111",
  copilot: "#000000",
  huoshan: "#3370FF",
};

const RULES: Array<[RegExp, string]> = [
  [/deepseek/, "deepseek"],
  [/claude|anthropic/, "anthropic"],
  [/gemini/, "gemini"],
  [/grok|x\.ai|\bxai\b/, "grok"],
  [/qwen|通义|dashscope/, "qwen"],
  [/kimi|moonshot/, "kimi"],
  [/glm|zhipu|智谱/, "zhipu"],
  [/doubao|豆包|volcengine/, "doubao"],
  [/minimax/, "minimax"],
  [/gpt-|chatgpt|openai/, "openai"],
  [/newapi/, "newapi"],
  [/ollama/, "ollama"],
  [/openrouter/, "openrouter"],
  [/mistral/, "mistral"],
  [/siliconflow|硅基/, "siliconflow"],
  [/azure/, "azure"],
  [/google/, "google"],
];

export function inferVendor(input: { icon?: string; name?: string; model?: string; website?: string }): string {
  const icon = (input.icon || "").trim().toLowerCase();
  if (icon && !icon.startsWith("data:") && icon !== "currentcolor") return icon;
  const blob = `${input.name || ""} ${input.model || ""} ${input.website || ""}`.toLowerCase();
  for (const [pattern, id] of RULES) {
    if (pattern.test(blob)) return id;
  }
  return "";
}

export function vendorColor(id: string, fallback = "#4c78f0"): string {
  return VENDOR_COLOR[id] || fallback;
}

export function vendorSrc(id: string): string {
  const file = VENDOR_FILE[id];
  return file ? `/vendors/${file}` : "";
}
