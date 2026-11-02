import test from 'node:test';
import assert from 'node:assert/strict';
import { complete } from './llm-gateway.ts';

const provider = { id:'synthetic', name:'test',protocol:'openai',baseUrl:'https://api.deepseek.com',model:'deepseek-flash',secret:'mock-model-key',auth:'bearer' };
test('DeepSeek V4 text/tool workflow explicitly disables incompatible default thinking mode',async()=>{
  let payload: Record<string,unknown>={};
  const result=await complete(provider,[{role:'user',content:'synthetic'}],{stream:false,fetchImpl:async(_url,init)=>{
    payload=JSON.parse(String(init?.body));
    return Response.json({choices:[{message:{content:'ok'},finish_reason:'stop'}]});
  }});
  assert.equal(result.ok,true);
  assert.deepEqual(payload.thinking,{type:'disabled'});
});
test('DeepSeek-specific controls are not sent to unrelated compatible endpoints',async()=>{
  let payload: Record<string,unknown>={};
  await complete({...provider,baseUrl:'https://example.com/v1'},[{role:'user',content:'synthetic'}],{stream:false,fetchImpl:async(_url,init)=>{
    payload=JSON.parse(String(init?.body));
    return Response.json({choices:[{message:{content:'ok'},finish_reason:'stop'}]});
  }});
  assert.equal(payload.thinking,undefined);
});
test('empty output at a token limit is explained rather than reported as ordinary empty content',async()=>{
  const result=await complete(provider,[{role:'user',content:'synthetic'}],{stream:false,fetchImpl:async()=>Response.json({choices:[{message:{content:''},finish_reason:'length'}],usage:{prompt_tokens:100,completion_tokens:12000}})});
  assert.equal(result.ok,false);
  assert.match(result.detail,/输出上限/);
});
