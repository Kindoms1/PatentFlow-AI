import { useState } from "react";
import { importProviderText } from "./provider-api.ts";
import { useStore } from "./store.tsx";

export function ImportPanel({
  compact = false,
  onImported,
}: {
  compact?: boolean;
  onImported?: () => void;
}) {
  const { notify } = useStore();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (value: string) => {
    const payload = value.trim();
    if (!payload) {
      notify("先粘贴 CC Switch 的配置，或选择文件。");
      return;
    }
    setBusy(true);
    const result = await importProviderText(payload);
    setBusy(false);
    if (result.error) {
      notify(result.error);
      return;
    }
    setText("");
    notify(`已导入 ${result.imported ?? result.providers?.length ?? 0} 个提供方，密钥留在服务端。`);
    onImported?.();
  };

  return (
    <form
      className={compact ? "import-panel compact" : "import-panel stack-form"}
      onSubmit={(event) => {
        event.preventDefault();
        void run(text);
      }}
    >
      {compact ? null : <h2>CC Switch 一键导入</h2>}
      <p className="fine">粘贴 Claude / Codex 的 JSON、ccswitch:// 链接、config.toml，或从文件导入。密钥只保存在服务端，不会出现在页面里。</p>
      <textarea
        value={text}
        rows={compact ? 5 : 7}
        placeholder={'ccswitch://v1/import?resource=provider&app=claude&name=...\n或\n{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://example.com",\n    "ANTHROPIC_API_KEY": "..."\n  }\n}'}
        aria-label="CC Switch 配置"
        onChange={(event) => setText(event.target.value)}
      />
      <div className="composer-bar">
        <button className="btn primary" type="submit" disabled={busy || !text.trim()}>{busy ? "正在导入" : "导入并切换"}</button>
        <button
          className="btn ghost"
          type="button"
          disabled={busy}
          onClick={() => {
            void navigator.clipboard.readText().then((value) => {
              if (!value.trim()) {
                notify("剪贴板是空的。");
                return;
              }
              setText(value);
              void run(value);
            }).catch(() => notify("浏览器没有允许读取剪贴板。"));
          }}
        >
          从剪贴板导入
        </button>
        <label className="btn ghost file-btn">
          选择文件
          <input
            type="file"
            accept=".json,.txt,.toml,.sql,application/json,text/plain"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              void file.text().then((value) => {
                setText(value);
                return run(value);
              });
              event.target.value = "";
            }}
          />
        </label>
      </div>
    </form>
  );
}
