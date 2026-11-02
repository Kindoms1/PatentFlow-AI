import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Document, Packer, Paragraph } from 'docx';
import { readUserFile } from './read-user-file.ts';
import { writeZip } from './zip.ts';

test('uploaded text-layer PDF is actually decoded through the file reader',async()=>{
  const bytes=readFileSync(new URL('../public/sample-invention.pdf',import.meta.url));
  const result=await readUserFile(new File([bytes],'example.pdf',{type:'application/pdf'}));
  assert.equal(result.ok,true,result.ok?'':result.reason);
  if(result.ok){assert.equal(result.file.format,'pdf');assert.ok(result.file.chars>100);}
});
test('uploaded DOCX preserves Chinese paragraph text',async()=>{
  const bytes=await Packer.toBuffer(new Document({sections:[{children:[new Paragraph('合成测试材料：分区流量采集。'),new Paragraph('第二步：根据流量偏差控制阀门。')]}]}));
  const result=await readUserFile(new File([new Uint8Array(bytes)],'synthetic.docx'));
  assert.equal(result.ok,true);
  if(result.ok){assert.match(result.file.text,/分区流量采集/);assert.match(result.file.text,/根据流量偏差控制阀门/);}
});
test('uploaded presentation and spreadsheet archives use their document parts',async()=>{
  const enc=new TextEncoder();
  const ppt=await writeZip([{name:'ppt/slides/slide1.xml',data:enc.encode('<p:sld><a:p><a:r><a:t>合成演示文稿主题</a:t></a:r></a:p></p:sld>')}]);
  const slides=await readUserFile(new File([ppt as BlobPart],'synthetic.pptx'));
  assert.equal(slides.ok,true);
  if(slides.ok)assert.match(slides.file.text,/合成演示文稿主题/);
  const xlsx=await writeZip([{name:'xl/worksheets/sheet1.xml',data:enc.encode('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>分区编号</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>')}]);
  const sheet=await readUserFile(new File([xlsx as BlobPart],'synthetic.xlsx'));
  assert.equal(sheet.ok,true);
  if(sheet.ok){assert.match(sheet.file.text,/分区编号/);assert.match(sheet.file.text,/42/);}
});
test('text and structured uploads retain the provided facts',async()=>{
  for(const name of ['material.txt','material.md','material.csv','material.json','material.py']) {
    const result=await readUserFile(new File(['合成测试值：42'],name));
    assert.equal(result.ok,true,name);
    if(result.ok)assert.match(result.file.text,/42/);
  }
});
test('unsupported legacy Office and empty files fail with actionable messages',async()=>{
  const legacy=await readUserFile(new File(['synthetic'],'legacy.doc'));
  assert.equal(legacy.ok,false);if(!legacy.ok)assert.match(legacy.reason,/旧格式/);
  const empty=await readUserFile(new File([],'empty.txt'));
  assert.equal(empty.ok,false);if(!empty.ok)assert.match(empty.reason,/空文件/);
});
