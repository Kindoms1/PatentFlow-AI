import { useEffect, useState } from "react";
import { ImportPanel } from "./import-panel.tsx";
import { activateProvider, addProvider, importCcSwitch, listCcSwitch, selectProviderModel } from "./provider-api.ts";
import type { CcLocalProvider, PublicProvider } from "./provider-api.ts";
import { VendorMark } from "./vendor-mark.tsx";
import { useStore } from "./store.tsx";

export function ModelMenu({
  providers,
  onChanged,
  compactImport = true,
}: {
  providers: PublicProvider[];
  onChanged: () => void;
  compactImport?: boolean;
}) {
  const { notify } = useStore();
  const [local, setLocal] = useState<CcLocalProvider[]>([]);
  const [detail, setDetail] = useState("正在读取 CC Switch 配置。");
  const [adding, setAdding] = useState<"off" | "import" | "manual">("off");
  const [busy, setBusy] = useState("");
  const models = providers.filter((item) => item.role === "model");

  const loadLocal = () => {
    void listCcSwitch().then((found) => {
      setLocal(found.providers);
      setDetail(found.detail);
    }).catch(() => setDetail("没有读到 CC Switch 配置。"));
  };

  useEffect(() => {
    const timer = window.setTimeout(loadLocal, 0);
    return () => window.clearTimeout(timer);
  }, []);

  // One click on a provider card uses its current model, or the first listed model when none is set yet.
  // The chips under the card are only for switching to a different model of the same provider.
  const pickSaved = (item: PublicProvider, model?: string) => {
    const target = model || item.model || item.models?.[0] || "";
    if (item.active && target === item.model) {
      onChanged();
      return;
    }
    setBusy(item.id + target);
    const run = target && target !== item.model
      ? selectProviderModel(item.id, target).then(() => activateProvider(item.id))
      : activateProvider(item.id);
    void run
      .then(() => onChanged())
      .catch(() => notify("切换模型没有成功，请稍后再试。"))
      .finally(() => setBusy(""));
  };

  const useLocal = (item: CcLocalProvider, model: string) => {
    if (!item.canImport) {
      notify(item.reason || "这个提供方还不能导入。");
      return;
    }
    setBusy(item.key + model);
    void importCcSwitch(item.key, model).then((result) => {
      setBusy("");
      if (result.error) {
        notify(result.error);
        return;
      }
      notify(`已从 CC Switch 切换到 ${item.name}${model ? ` · ${model}` : ""}。密钥留在服务端。`);
      onChanged();
    });
  };

  return (
    <div className="model-sheet">
      <p>已接入</p>
      {models.length === 0 ? <small className="fine">还没有可用模型。</small> : null}
      {models.map((item) => (
        <div
          key={item.id}
          className={item.active ? "model-block active" : "model-block"}
          title="点整张卡片即用默认模型；要换模型再点下面的标签"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) return;
            pickSaved(item);
          }}
        >
          <button type="button" className={item.active ? "model-row active" : "model-row"} onClick={() => pickSaved(item)}>
            <VendorMark icon={item.icon} name={item.name} model={item.model} website={item.website} color={item.iconColor} />
            <span>
              <b>{item.model || item.name}</b>
              <small>{item.name} · {item.protocol === "claude" ? "Claude" : "OpenAI"}</small>
            </span>
            <em>{busy.startsWith(item.id) ? "切换中" : item.active ? "使用中" : "一键选用"}</em>
          </button>
          {(item.models ?? []).length > 1 ? (
            <div className="model-chips">
              {item.models?.map((model) => (
                <button
                  key={model}
                  type="button"
                  className={item.active && item.model === model ? "active" : !item.active && (item.model || item.models?.[0]) === model ? "default" : undefined}
                  title={(item.model || item.models?.[0]) === model ? "默认模型" : undefined}
                  onClick={() => pickSaved(item, model)}
                >
                  {model}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ))}
      <CcSwitchShelf local={local} detail={detail} busy={busy} onRefresh={loadLocal} onUse={useLocal} />
      <button type="button" className="add-model" onClick={() => setAdding((value) => (value === "import" ? "off" : "import"))}>粘贴 CC Switch 链接</button>
      {compactImport ? <button type="button" className="add-model" onClick={() => setAdding((value) => (value === "manual" ? "off" : "manual"))}>手动填写</button> : null}
      {adding === "import" ? <ImportPanel compact={compactImport} onImported={onChanged} /> : null}
      {adding === "manual" ? <ManualAdd onChanged={onChanged} /> : null}
    </div>
  );
}

export function CcSwitchShelf({
  local,
  detail,
  busy,
  onRefresh,
  onUse,
}: {
  local: CcLocalProvider[];
  detail: string;
  busy: string;
  onRefresh: () => void;
  onUse: (item: CcLocalProvider, model: string) => void;
}) {
  return (
    <section className="cc-shelf">
      <header>
        <p>CC Switch</p>
        <button type="button" onClick={onRefresh}>重新读取</button>
      </header>
      <small className="fine">{detail}</small>
      <div className="cc-local">
        {local.map((item) => {
          const choices = item.models.length ? item.models : item.model ? [item.model] : [];
          return (
            <article key={item.key} className={item.current ? "cc-card current" : "cc-card"}>
              <VendorMark icon={item.icon} name={item.name} model={choices[0]} website={item.website} color={item.iconColor} size={28} />
              <div>
                <b>{item.name}</b>
                <small>{item.appLabel}{item.host ? ` · ${item.host}` : ""}{item.current ? " · CC Switch 当前" : ""}{item.hasKey ? "" : " · 无密钥"}</small>
              </div>
              {choices.length ? (
                <div className="model-chips">
                  {choices.map((model) => (
                    <button key={model} type="button" disabled={!item.canImport || busy === item.key + model} onClick={() => onUse(item, model)}>
                      {model}
                    </button>
                  ))}
                </div>
              ) : (
                <small className="fine">{item.reason || "没有列出具体模型。"}</small>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ManualAdd({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<"openai" | "claude">("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="add-model-form"
      onSubmit={(event) => {
        event.preventDefault();
        void addProvider({ name, protocol, baseUrl, model, apiKey }).then((message) => {
          if (message) {
            setError(message);
            return;
          }
          onChanged();
        });
      }}
    >
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="名称" aria-label="模型名称" />
      <select value={protocol} onChange={(event) => setProtocol(event.target.value as "openai" | "claude")} aria-label="协议">
        <option value="openai">OpenAI 协议</option>
        <option value="claude">Claude 协议</option>
      </select>
      <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="接口地址" aria-label="接口地址" />
      <input value={model} onChange={(event) => setModel(event.target.value)} placeholder="模型名" aria-label="模型名" />
      <input value={apiKey} type="password" onChange={(event) => setApiKey(event.target.value)} placeholder="密钥，只发到服务端" aria-label="密钥" autoComplete="off" />
      {error ? <small className="form-error">{error}</small> : null}
      <button className="btn primary" type="submit">保存并切换</button>
    </form>
  );
}
