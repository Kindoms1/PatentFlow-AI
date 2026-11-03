# 使用自己的 AI 模型（BYOK）

邀请测试站同时提供「站点默认模型」和「我的 AI 模型」。个人配置只影响当前浏览器，不能读取或覆盖管理员的 Key。使用个人模型不会自动回退到站点额度；缺少 Key 或调用失败时会提示错误。

## 用户步骤

1. 进入「设置 → 我的 AI 模型」，或点击对话框下方的模型名称。
2. 选择服务模板，核对 API Base URL，填写服务商实际提供的模型 ID 和自己的 API Key。
3. 确认信任本站网关与目标服务后，可「获取模型列表」或「测试连接」。测试会真实调用模型，可能产生少量费用。
4. 点击「保存并使用」，返回对话即可阅读附件、生成申请文件、继续修改与导出。当前模型名称会显示在输入框下方。
5. 可以编辑、切换、删除个人配置，也可以随时切回「站点默认模型」。进行中的一轮会固定使用开始时的配置，修改设置只影响后续轮次。

Key 默认仅放在当前页面内存中，刷新后需重新填写。配置名称、服务地址、模型 ID 等非密钥信息会留在当前浏览器。

勾选「在本标签页记住 Key」后，Key 放入非加密的 sessionStorage，可在刷新后恢复；关闭标签页通常会清除，但浏览器的会话恢复可能恢复它。共享电脑不要勾选；删除配置可清除对应的保留 Key。Key 不进入案件、知识库或审计导出。

## 接口范围

- OpenAI Chat Completions 兼容协议：内置 DeepSeek、Agnes、OpenAI、Gemini 兼容接口、通义千问、Kimi、智谱 GLM、硅基流动、OpenRouter 模板。
- Anthropic Messages：独立协议与 x-api-key 认证，支持文字流式输出与工具调用。
- 允许手动填写准确的模型 ID，不依赖硬编码型号。模型列表接口不存在或无权限时，仍可手动填写。
- 支持 max_tokens / max_completion_tokens 参数选择；自动模式对 OpenAI 官方端点使用后者。
- 单次输出可设置为 256–32000 tokens，实际还受本站上限与上游模型额度限制。长篇申请文件需要足够的上下文与输出容量；自动查新流程还要求模型支持工具调用。
- 原生 Responses-only、Gemini 原生 generateContent、OAuth 登录型服务和本机 localhost 接口不属于这两个协议，不宣称即填即用。Gemini 请使用其 OpenAI 兼容地址。

模板只是预留的协议配置，不表示这些厂商的全部型号都已真实测试。服务地域、额度、模型权限和供应商参数要求由各家决定。

## 新服务接入

在 worker/byok.ts 的校验中，只有精确允许的公网 HTTPS 域名可以作为 BYOK 目的地。常见服务域名已预置；其他可信网关由部署者在 Worker 环境配置 BYOK_ALLOWED_HOSTS，例如：

    BYOK_ALLOWED_HOSTS=relay.example.com,another.example.com

不支持通配域名、IP 地址、任意端口、URL 内嵌账号和查询参数。上游重定向不会被跟随。即使新域名获准，也只会收到用户自己填写的 Key，不会收到管理员的模型 Key。部署者只应放行可信公共模型服务。

设置 BYOK_ENABLED=false 可关闭个人模型入口。默认开启；这不会开放管理员的凭据管理或 CC Switch 接口，也不会取消邀请码与调用限流。

## 开发接口

- GET /api/providers：返回公开默认模型信息及 byok.enabled、byok.allowedHosts，不返回任何 Key。
- POST /api/byok/test：接收 clientProvider，验证一条短回复，返回成功状态与诊断，不保留配置。
- POST /api/byok/models：接收 clientProvider，读取模型列表；无需预先知道模型 ID。
- POST /api/chat 或 /api/agent：可携带 clientProvider；省略时用站点默认模型。自带配置格式：

    {
      "name": "我的模型",
      "protocol": "openai",
      "baseUrl": "https://api.deepseek.com/v1",
      "model": "服务商提供的模型 ID",
      "apiKey": "仅在真实请求中填入自己的密钥",
      "maxOutputTokens": 24000,
      "tokenParameter": "auto"
    }

所有接口仍要求有效邀请码会话和同源请求。部署者不应记录请求体；测试录制会移除 clientProvider.apiKey。个人模型只替代模型服务，检索仍使用本站的 AnySearch 配置及限流。

## 本轮真实验证

2026-11-03：DeepSeek 的个人 Key 云端短回复已成功。Agnes 从 Cloudflare 调用仍返回 429 / 1015，因此没有换为默认服务；其模板保留，但不标记为可用保证。完整生成与发布复测结果见 [发布验证记录](release-validation.md)。
