# PatentFlow AI

通过对话梳理技术主题，读取交底材料，检索对比文件，生成、修改和导出发明专利申请文件。

本仓库包含可运行的前端、服务端模型/检索网关、Cloudflare Worker、附图与 Word/ZIP 导出源码，采用 **Apache-2.0**。不包含作者的 API Key、私人发明材料、历史备份或生成文档。

## 功能

- 主题讨论、候选发明点、技术交底书、查新对比和完整申请文件生成。
- 读取 PDF、DOCX、PPTX、XLSX、文本、网页等材料；扫描件和图片不应被当作已经 OCR 识别的正文。
- 按稿件数据绘制黑白附图，检查图号、标记、权利要求引用和公式。
- 成稿后定点修改、复核和撤销；检查不通过时保留原稿。
- 导出分件 DOCX、合订稿、附图 PNG 和全套 ZIP。
- 本地案件、知识库和检索专题；云端体验采用邀请码访问。

模型生成内容和公开检索结果需要人工核实。结构检查通过不等于具备新颖性、创造性或保证授权。

## 本地运行

需要 Node.js 24 和 npm。

```sh
git clone https://github.com/anticipate218/PatentFlow-AI.git
cd PatentFlow-AI
npm ci
```

复制 `.env.example` 为 `.env.local`，只在本地文件中填入自己的模型和检索 Key。例如 DeepSeek 使用 `AGNES_BASE_URL=https://api.deepseek.com` 和账户实际可用的模型名；变量名 `AGNES_*` 保留用于兼容旧配置，并不限于某一家模型。

```sh
npm run dev -- --host localhost --port 5173
```

打开 `http://localhost:5173/`。模型与搜索是两项独立服务；没有检索 Key 时不能完成真实联网查新。开发服务器只供本机使用，不能作为公网部署直接暴露。

## 在线体验与部署

在线邀请测试：https://patentflow-ai.patentflow-ai.workers.dev/ （需要维护者提供的邀请码，目前使用临时测试配置）。

公开体验站采用 **服务端 Key + 限量邀请**。Key 不提供给体验者；当前邀请测试经过维护者明确授权使用测试配置，正式运营前应替换为专用正式 Key。实际验证状态见 [发布验证记录](docs/release-validation.md)。

完整产品需要后端。仅把 `dist` 放在 GitHub Pages 不能运行模型、搜索或 Agent API。推荐将前端静态资源和 `/api/*` 一起部署到 Cloudflare Worker，详见 [Cloudflare 部署说明](docs/cloudflare-deploy.md)。免费托管额度不包含模型和搜索费用，也不保证长文生成一定满足免费 CPU 限额。

## 测试

```sh
npm test
npm run check:worker
npm run build
npm run verify
```

`verify` 包含自动化测试、lint、Worker 类型检查、构建、源码和构建产物敏感信息扫描。GitHub Actions 模板保存在 `.github/templates/ci.yml`；有工作流管理权限的维护者可将其复制到 `.github/workflows/ci.yml`，对 push/PR 执行同样检查，无需真实 API Key。初次发布所用授权没有 workflow 权限，因此模板默认不启用。

另有可选真实集成测试：启动配置好测试密钥的本地 Worker 后运行 `node scripts/worker-smoke.mjs`，再运行 `node scripts/live-pipeline.mjs`。后一项会实际调用模型和检索服务，并可能产生费用；输出保存在被忽略的 `.tmp-library` 中。它检查真实一键生成、形式核查、附图、DOCX/ZIP 和成稿后修改，不替代浏览器实测与 Word 排版审阅。

## 结构

| 目录 | 内容 |
| --- | --- |
| `src/` | React UI、案件状态、材料解析、专利流程、附图和文件导出 |
| `server/` | 模型协议适配、流式 Agent、检索、开发环境凭据管理 |
| `worker/` | 云端部署入口、邀请码门禁、请求限制及测试 |
| `scripts/` | 本地验证、发布扫描和部署辅助 |
| `public/` | 网站资源及通用示例材料 |

## 数据与贡献

案件保存在当前浏览器中；更换设备不会自动同步。执行模型操作时，相关材料会发送给所配置的模型服务。请先阅读 [安全与隐私说明](SECURITY.md)。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，第三方依赖和图标归属见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。应用源码使用 [Apache-2.0](LICENSE)，第三方资产保留其原有许可。
