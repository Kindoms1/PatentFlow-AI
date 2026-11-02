# Cloudflare 邀请体验部署

## 前提

准备自己的 Cloudflare 账号、专用正式模型 Key、检索 Key。不要把聊天中提供的测试 Key 放入正式站点，也不要将 `.env.local` 或 `.dev.vars` 上传到 GitHub。

## 本地 Worker 验证

`npm ci` 后填写本机 `.env.local`，运行：

```sh
node scripts/cf-dev-vars.mjs
npm run cf:dev
```

配置写入被忽略的 `.dev.vars`。邀请码在该文件的 `ACCESS_CODES` 中；首页和静态资源均要求登录。首次启动后打开 `http://127.0.0.1:8787/`。修改 `.dev.vars` 后重新启动 Wrangler，以免使用旧环境值。

```sh
npm run test:worker
node scripts/live-pipeline.mjs
```

真实集成测试使用服务端现有配置，可能产生模型和搜索费用。只使用合成材料测试。

## 正式发布

1. 执行 `npx wrangler login`，在浏览器中登录并授权自己的账号。
2. 检查 `npx wrangler whoami`、Worker 名称和账号计划。
3. 执行 `npm run cf:deploy`。首次没有门禁配置时站点返回 503，这是预期的关闭状态。
4. 准备被忽略的 `.env.production.local`，填入专用正式 `AGNES_API_KEY`、`AGNES_BASE_URL`、`AGNES_MODEL`、`ANYSEARCH_API_KEY`、`ANYSEARCH_BASE_URL`。
5. 执行 `npm run cf:secrets` 写入服务端 secrets 和新生成的邀请码。不要把输出中的邀请码放进公开日志或仓库。
6. 在实际 `workers.dev` 地址逐项验证：未登录访问、邀请码登录、静态资源、搜索、长文流式生成、修改、撤销、PNG/DOCX/ZIP 下载、刷新后案件保存。

不得把 `wrangler deploy` 成功等同于真实业务验证通过。公网不可达、模型无额度、搜索失败和免费 CPU 超限都需要分别记录。

## 使用边界

- `AGENT_PER_HOUR` 和 `TOOLS_PER_HOUR` 是单 isolate 内存限流；不能当作全局账单上限。
- `MAX_OUTPUT_TOKENS` 是每次上游调用的上限；一键生成会多次调用模型。
- 修改/删除某个邀请码后，该邀请码之前发出的会话也会失效。轮换 `SESSION_SECRET` 会让全部用户退出。
- 浏览器前端代码和提示词可查看；开源后这是预期行为。模型 Key 仍只在服务端。
- 不上传 `.tmp-library`、私人附件、开发服务器凭据或历史备份。只发布 `dist` 和 Worker 构建产物。
- Workers Free 的请求和 CPU 限额应以官方当前文档为准。长文流处理的 CPU 需要线上实测；本地 workerd 不代表线上免费额度验证。

官方参考：
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/configuration/secrets/
