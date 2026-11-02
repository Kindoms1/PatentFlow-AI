import test from 'node:test';
import assert from 'node:assert/strict';
import { createTopic } from './skill-turn.ts';
import { runAutoPatent } from './auto-flow.ts';
import type { ChatMessage } from './model.ts';

const REQUEST = '围绕温室滴灌管路堵塞的在线检测与分区补偿控制，一句话全自动生成完整发明专利申请文件。请先检索和对比再撰写，包含详细实施例和至少5幅各有用途的附图。';
test('explicit technical subject wins over words describing output completeness', () => {
  assert.equal(createTopic(REQUEST), '温室滴灌管路堵塞的在线检测与分区补偿控制');
  assert.equal(createTopic('帮我生成完整发明专利申请文件'), '');
});

async function selectionPrompt(userText: string, history: ChatMessage[] = []) {
  let captured = '';
  await runAutoPatent({caseId:'synthetic', userText, history, materials:[],dispatch:()=>{}}, {
    ask: async messages => { captured = messages.map(item=>item.content).join('\n'); return {ok:false,text:'',detail:'stopped after capture',model:'fake',aborted:true}; },
    draft:{ask:async()=>{throw new Error('draft must not run');},search:async()=>{throw new Error('search must not run');}},
  });
  return captured;
}
test('automatic selection retains the original user requirements even when a topic is recognized', async () => {
  assert.ok((await selectionPrompt(REQUEST)).includes(REQUEST));
});
test('automatic continuation uses the most recently requested topic', async () => {
  const history = ['帮我写一个电池领域的发明专利', '改为帮我写一个智慧农业领域的发明专利'].map((text,index)=>({id:String(index),role:'user' as const,text,at:'2026-11-02'}));
  const prompt=await selectionPrompt('按你的建议，直接完成全套申请文件',history);
  assert.ok(prompt.includes('我想写一件「智慧农业」方向的发明专利。'));
});
