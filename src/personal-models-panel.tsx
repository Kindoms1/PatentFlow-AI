import { useEffect, useState } from 'react';
import { getByokCapability, inspectPersonalModel } from './provider-api.ts';
import { MODEL_PRESETS } from './model-presets.ts';
import type { ModelProtocol, PersonalModelInput, TokenParameter } from './model-presets.ts';
import { PERSONAL_MODELS_CHANGED, personalModels } from './personal-models.ts';
import type { PersonalModel } from './personal-models.ts';

export function PersonalModelsPanel({ onChanged }: { onChanged: () => void }) {
  const [profiles, setProfiles] = useState(() => personalModels().list());
  const [editing, setEditing] = useState<PersonalModel | 'new' | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    const reload = () => setProfiles(personalModels().list());
    window.addEventListener(PERSONAL_MODELS_CHANGED, reload);
    return () => window.removeEventListener(PERSONAL_MODELS_CHANGED, reload);
  }, []);
  if (!getByokCapability().enabled) return null;
  const changed = () => { setProfiles(personalModels().list()); onChanged(); };
  return <section className="personal-models" aria-label="我的 AI 模型">
    <header><div><h3>我的 AI 模型 <span>BYOK</span></h3><p className="fine">用自己的服务与额度，配置只对当前浏览器可见。</p></div></header>
    <p className="byok-privacy">Key 默认仅留在当前页面内存；测试或生成时经本站网关转发给你指定的模型服务，不写入本站配置或案件导出。请使用低额度专用 Key，并确认你信任本站与目标服务。</p>
    <button type="button" className="btn ghost" disabled={!!busy || (!profiles.some(p => p.active) && !personalModels().managedId())} onClick={() => { personalModels().use(); setStatus('已切回站点默认模型。'); changed(); }}>使用站点默认模型</button>
    {profiles.map(profile => <article key={profile.id} className={'byok-profile' + (profile.active ? ' active' : '')}>
      <div><strong>{profile.name}</strong><span className="byok-badge">{profile.active ? '当前使用' : '个人配置'}</span></div>
      <p>{profile.model}</p><small>{profile.baseUrl} · {profile.hasKey ? profile.rememberSession ? '本标签页记住 Key' : 'Key 仅存内存' : '需重新填 Key'}</small>
      <div className="byok-actions">
        <button type="button" disabled={!!busy || profile.active} onClick={() => { personalModels().use(profile.id); changed(); }}>使用</button>
        <button type="button" disabled={!!busy} onClick={() => { setEditing(profile); setStatus(''); }}>编辑 / 填 Key</button>
        <button type="button" disabled={!!busy || !profile.hasKey} onClick={() => {
          setBusy(profile.id); setStatus('正在通过本站网关测试，可能产生少量模型费用…');
          void inspectPersonalModel(personalModels().request(profile.id)!, 'test').then(result => setStatus(result.detail)).catch(() => setStatus('测试未完成，请检查网络后重试。')).finally(() => setBusy(''));
        }}>{busy === profile.id ? '测试中…' : '测试连接'}</button>
        <button type="button" disabled={!!busy} onClick={() => { personalModels().remove(profile.id); if (editing !== 'new' && editing?.id === profile.id) setEditing(null); setStatus('已移除个人配置与本标签页保存的 Key。'); changed(); }}>删除配置</button>
      </div>
    </article>)}
    {!editing ? <button type="button" className="btn primary" disabled={!!busy} onClick={() => { setEditing('new'); setStatus(''); }}>添加自己的模型</button> : <PersonalModelForm key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setStatus(personalModels().warning() || '已保存并使用个人模型。未进行真实调用的配置不代表已验证兼容。'); changed(); }} />}
    {status ? <p className="byok-status" role="status">{status}</p> : null}
    <p className="fine">支持 OpenAI Chat Completions 兼容协议及 Anthropic Messages。各服务的模型 ID、上下文与工具能力不同；模板不等于实测认证。新域名可由管理员加入 BYOK_ALLOWED_HOSTS。</p>
  </section>;
}

function PersonalModelForm({ initial, onClose, onSaved }: { initial?: PersonalModel; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name || '我的 DeepSeek');
  const [protocol, setProtocol] = useState<ModelProtocol>(initial?.protocol || 'openai');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || MODEL_PRESETS[0].baseUrl);
  const [model, setModel] = useState(initial?.model || '');
  const [apiKey, setApiKey] = useState('');
  const [limit, setLimit] = useState(initial?.maxOutputTokens || 32000);
  const [tokenParameter, setTokenParameter] = useState<TokenParameter>(initial?.tokenParameter || 'auto');
  const [remember, setRemember] = useState(initial?.rememberSession || false);
  const [consent, setConsent] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [status, setStatus] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const currentKey = () => {
    if (apiKey.trim()) return apiKey.trim();
    if (initial?.hasKey && initial.baseUrl === baseUrl.trim() && initial.protocol === protocol) return personalModels().request(initial.id)?.apiKey || '';
    return '';
  };
  const input = (listing = false): PersonalModelInput => {
    if (!consent) throw new Error('请先确认信任本站网关和目标模型服务。');
    let url: URL; try { url = new URL(baseUrl.trim()); } catch { throw new Error('请填写完整的 HTTPS API Base URL。'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new Error('地址必须是无账号、参数和自定义端口的公网 HTTPS 地址。');
    if (!getByokCapability().allowedHosts.includes(url.hostname)) throw new Error('此域名尚未开放，请联系管理员加入 BYOK_ALLOWED_HOSTS。');
    const key = currentKey();
    if (!name.trim() || (!listing && !model.trim())) throw new Error('请填写配置名称和服务商提供的准确模型 ID。');
    if (key.length < 8 || key.length > 2048 || [...key].some(char => char.charCodeAt(0) < 33 || char.charCodeAt(0) > 126)) throw new Error('请填写有效的 API Key；更换服务地址后需重新填写。');
    if (!Number.isInteger(limit) || limit < 256 || limit > 32000) throw new Error('输出上限应为 256–32000 tokens，且不超过模型支持的范围。');
    return { name: name.trim(), protocol, baseUrl: baseUrl.trim(), model: model.trim(), apiKey: key, maxOutputTokens: limit, tokenParameter };
  };
  const inspect = (action: 'test' | 'models') => {
    let value: PersonalModelInput;
    try { value = input(action === 'models'); } catch (error) { setStatus((error as Error).message); return; }
    setBusy(action); setStatus(action === 'test' ? '正在测试短回答，可能产生少量模型费用…' : '正在获取模型列表…');
    void inspectPersonalModel(value, action).then(result => { setStatus(result.detail); if (result.models) setModels(result.models); }).catch(() => setStatus('请求未完成，请检查网络后重试。')).finally(() => setBusy(''));
  };
  return <form className="byok-form" onSubmit={event => {
    event.preventDefault();
    try { personalModels().save(input(), remember, initial?.id); setApiKey(''); onSaved(); } catch (error) { setStatus((error as Error).message); }
  }}>
    <label>服务模板<select aria-label="服务模板" defaultValue={initial ? 'custom' : 'deepseek'} onChange={event => {
      const preset = MODEL_PRESETS.find(item => item.id === event.target.value)!;
      setName('我的 ' + preset.name); setProtocol(preset.protocol); setBaseUrl(preset.baseUrl); setModel(''); setApiKey(''); setConsent(false); setModels([]); setStatus('');
    }}>{MODEL_PRESETS.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>
    <label>配置名称<input aria-label="配置名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} required /></label>
    <label>接口协议<select aria-label="接口协议" value={protocol} onChange={event => { setProtocol(event.target.value as ModelProtocol); setApiKey(''); setConsent(false); }}><option value="openai">OpenAI Chat Completions 兼容</option><option value="claude">Anthropic Messages</option></select></label>
    <label>API Base URL<input aria-label="API Base URL" type="url" value={baseUrl} onChange={event => { setBaseUrl(event.target.value); setApiKey(''); setConsent(false); }} required spellCheck={false} /></label>
    <label>模型 ID<input aria-label="模型 ID" value={model} list="byok-model-options" onChange={event => setModel(event.target.value)} placeholder="填写服务商实际提供的模型 ID" required maxLength={256} spellCheck={false} /></label>
    <datalist id="byok-model-options">{models.map(item => <option key={item} value={item} />)}</datalist>
    <label>API Key<div className="byok-key"><input aria-label="API Key" type={showKey ? 'text' : 'password'} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder={initial?.hasKey ? '同一服务留空保留当前 Key' : '仅发送给你选择的服务'} autoComplete="off" spellCheck={false} /><button type="button" onClick={() => setShowKey(!showKey)} aria-label={showKey ? '隐藏 Key' : '显示 Key'}>{showKey ? '隐藏' : '显示'}</button></div></label>
    <details><summary>兼容性与输出设置</summary>
      <label>单次最大输出 tokens<input aria-label="单次最大输出 tokens" type="number" min={256} max={32000} value={limit} onChange={event => setLimit(Number(event.target.value))} /></label>
      <label>输出长度参数<select aria-label="输出长度参数" value={tokenParameter} onChange={event => setTokenParameter(event.target.value as TokenParameter)}><option value="auto">自动（推荐）</option><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></label>
      <p className="fine">模型必须支持所选协议；完整查新流程还需要工具调用能力。Responses-only 接口及本机 localhost 不适用于此云端网关。</p>
    </details>
    <label className="byok-check"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />在本标签页记住 Key（sessionStorage，非加密存储；刷新可恢复，关闭标签页通常清除）</label>
    <label className="byok-check"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我信任本站与上面的服务地址，允许使用时转发我的 Key 和相关材料</label>
    {status ? <p className="byok-status" role="status">{status}</p> : null}
    <div className="byok-actions"><button type="submit" className="btn primary" disabled={!!busy}>保存并使用</button><button type="button" className="btn ghost" disabled={!!busy} onClick={() => inspect('test')}>{busy === 'test' ? '测试中…' : '测试连接'}</button><button type="button" className="btn ghost" disabled={!!busy} onClick={() => inspect('models')}>{busy === 'models' ? '读取中…' : '获取模型列表'}</button><button type="button" className="text-btn" disabled={!!busy} onClick={onClose}>取消</button></div>
  </form>;
}
