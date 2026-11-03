// Opt-in integration run against a locally running Worker or an explicitly configured test site.
// Never imports a model key; all model/search requests go through the same APIs as the UI.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { seed, reduce } from '../src/model.ts';
import { runPatentTurn } from '../src/skill-run.ts';
import { preparePackageZip } from '../src/export-package.ts';
import { readZip } from '../src/zip.ts';
import { formalCheck, parseApplication } from '../src/cnipa-format.ts';

const base = new URL(process.env.BASE || 'http://127.0.0.1:8787');
const local = ['127.0.0.1', 'localhost'].includes(base.hostname);
const vars = local && fs.existsSync('.dev.vars') ? parseEnv(fs.readFileSync('.dev.vars', 'utf8')) : {};
const code = process.env.CODE || (vars.ACCESS_CODES || '').split(',')[0];
if (!code) throw new Error('Set CODE for the explicitly selected test site.');
const out = path.resolve(process.env.TEST_OUTPUT || '.tmp-library/release-live');
fs.mkdirSync(out, { recursive: true });
const nativeFetch = globalThis.fetch;
const login = await nativeFetch(new URL('/__access', base), { method:'POST', body:new URLSearchParams({code}), redirect:'manual' });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
if (!cookie.startsWith('pf_session=')) throw new Error('Test-site login failed.');
const metrics = [];
const captures = [];
globalThis.fetch = (url, init) => {
  if (typeof url !== 'string' || !url.startsWith('/api/')) throw new Error('Unexpected browser-side request in integration test.');
  metrics.push({ path:url, at:new Date().toISOString() });
  const number = String(metrics.length).padStart(3,'0');
  // Synthetic test requests only. Never persist Cookie/Authorization or BYOK keys.
  const recordedBody = JSON.parse(String(init?.body || '{}'));
  if (recordedBody.clientProvider) recordedBody.clientProvider = { ...recordedBody.clientProvider, apiKey: '[REDACTED]' };
  fs.writeFileSync(path.join(out,number+'-request.json'),JSON.stringify(recordedBody));
  return nativeFetch(new URL(url,base), { ...init, headers:{ ...init?.headers, Cookie:cookie } }).then(response=>{
    // Handle cloning, reading and writing failures before the pipeline continues.
    // Exception text can contain upstream details; report only request metadata.
    const capture = Promise.resolve()
      .then(() => response.clone().text())
      .then(text => fs.writeFileSync(path.join(out,number+'-response.txt'),text))
      .catch(() => check('response capture saved', false, { request:number, path:url }));
    captures.push(capture);
    return response;
  });
};
let state = reduce(seed(), {type:'create-case',id:'release-synthetic',title:'合成案例：滴灌堵塞检测',text:'',fileName:'',skill:true});
const caseId = state.activeCaseId;
const dispatch = action => {
  state = reduce(state,action);
  fs.writeFileSync(path.join(out,'workspace.json'),JSON.stringify(state,null,2));
  if(action.type==='chat-note' && action.role==='trace') console.log('[progress] '+action.text.replace(/\s+/g,' ').slice(0,180));
};
const report = { startedAt:new Date().toISOString(), base:base.origin, scenario:'synthetic greenhouse drip irrigation', checks:[], requests:metrics };
const check = (name, ok, details={}) => { report.checks.push({name,ok,...details}); console.log(JSON.stringify({name,ok,...details})); };
try {
  await runPatentTurn({caseId, userText:'围绕温室滴灌管路堵塞的在线检测与分区补偿控制，一句话全自动生成完整发明专利申请文件。请先检索和对比再撰写，包含详细实施例和至少5幅各有用途的附图；不需要追问，未实测参数明确作为假设。',intent:'auto',materials:[],history:[],recordUser:true,dispatch});
  const patentCase = state.cases.find(item=>item.id===caseId);
  const draft = patentCase?.inventionDraft;
  check('one-sentence generation creates a complete saved draft',Boolean(draft?.text),{characters:draft?.text?.length || 0, claims:draft?.claimCount || 0});
  if(draft?.text) {
    fs.writeFileSync(path.join(out,'draft.md'),draft.text);
    const parsed = parseApplication(draft.text,patentCase.title);
    const formal = formalCheck(parsed);
    fs.writeFileSync(path.join(out,'formal.json'),JSON.stringify(formal,null,2));
    check('formal export gate passes',formal.exportable,{fatal:formal.fatal,figures:parsed.figures.length});
    if(formal.exportable) {
      const bundle = await preparePackageZip(draft.text,patentCase.title);
      fs.writeFileSync(path.join(out,'application-package.zip'),bundle.zip);
      const entries = await readZip(bundle.zip);
      let documents=0;let embeddedImages=0;
      for(const [name,bytes] of entries) if(name.endsWith('.docx')) {
        documents++;
        const parts=await readZip(bytes);
        check('valid DOCX: '+path.basename(name),parts.has('word/document.xml')&&parts.has('[Content_Types].xml'));
        embeddedImages += [...parts.keys()].filter(item=>item.startsWith('word/media/')).length;
      }
      check('full package contains documents and figures',documents>=7&&bundle.figureCount>=5&&embeddedImages>0,{documents,figures:bundle.figureCount,embeddedImages,bytes:bundle.zip.length});
    }
    let applied = false;
    const revisionDispatch = action => {
      dispatch(action);
      if (action.type === 'revise-invention-draft' && action.caseId === caseId) applied = true;
    };
    await runPatentTurn({caseId,userText:'仅润色说明书背景技术中的过渡句，使表达连贯。不要修改技术特征、权利要求、附图、附图标记或公式；保留全部其他内容。',intent:'revise',draft,materials:patentCase.materials,history:patentCase.messages,recordUser:true,dispatch:revisionDispatch});
    const revised=state.cases.find(item=>item.id===caseId)?.inventionDraft;
    const changed = Boolean(revised?.text?.trim()) && revised.text !== draft.text;
    const exportable = Boolean(revised?.text) && formalCheck(parseApplication(revised.text,patentCase.title)).exportable;
    check('revision preserves a complete draft and exportability',applied && changed && exportable,{applied,changed,exportable});
  }
} catch(error) { check('integration run completed without exception',false,{error:error instanceof Error?error.message:'unknown'}); }
finally {
  globalThis.fetch=nativeFetch;
  // Captures already handle rejection; finish their report entries before saving.
  await Promise.allSettled(captures);
  report.finishedAt=new Date().toISOString();
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
  process.exitCode=report.checks.some(item=>!item.ok)?1:0;
}
