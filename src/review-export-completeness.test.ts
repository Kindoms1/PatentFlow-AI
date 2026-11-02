import test from 'node:test';
import assert from 'node:assert/strict';
import { Document, Packer } from 'docx';
import { reviewSection } from './export-docx.ts';
import { parseApplication, formalCheck } from './cnipa-format.ts';
import { FIGURE_SAMPLE } from './figure-sample.ts';
import { readZip } from './zip.ts';

test('internal review export includes every annotation, including those after item 60',async()=>{
  const app=parseApplication(FIGURE_SAMPLE);
  app.reviewAnnotations=Array.from({length:103},(_,i)=>`核验事项${String(i+1).padStart(3,'0')}：此处为示例性设定。`);
  const bytes=await Packer.toBuffer(new Document({sections:[reviewSection(app,formalCheck(app),{})]}));
  const files=await readZip(bytes);
  const xml=new TextDecoder().decode(files.get('word/document.xml'));
  assert.match(xml,/核验事项103/);
  assert.doesNotMatch(xml,/处未列出/);
});

test('page footer uses a portable standalone page number rather than a blank section-total fraction',async()=>{
  const app=parseApplication(FIGURE_SAMPLE);
  const bytes=await Packer.toBuffer(new Document({sections:[reviewSection(app,formalCheck(app),{})]}));
  const files=await readZip(bytes);
  const footer=[...files].filter(([name])=>/^word\/footer\d+\.xml$/.test(name)).map(([,value])=>new TextDecoder().decode(value)).join('');
  assert.ok(footer.includes('PAGE'));
  assert.doesNotMatch(footer,/SECTIONPAGES/);
});
