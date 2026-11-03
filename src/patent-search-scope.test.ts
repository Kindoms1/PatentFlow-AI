import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patentWebQuery, patentPageLeads } from './patent-search-scope.ts';

test('patent page search scopes broad queries without changing explicit website instructions', () => {
  assert.deepEqual(patentWebQuery('滴灌 堵塞 检测'), { query: '滴灌 堵塞 检测 site:patents.google.com/patent', scoped: true });
  assert.deepEqual(patentWebQuery('滴灌 site:cnipa.gov.cn'), { query: '滴灌 site:cnipa.gov.cn', scoped: false });
  assert.deepEqual(patentWebQuery(''), { query: '', scoped: false });
});
test('patent-scoped leads exclude generic pages, lookalikes and malformed URLs', () => {
  const urls = ['https://patents.google.com/patent/CN123456A/zh', 'https://patents.google.com/', 'https://patents.google.com.evil.example/patent/CN1A', 'https://drive.google.com/folder', 'not-a-url'];
  const items = urls.map(url => ({ url }));
  assert.deepEqual(patentPageLeads(items, true), [items[0]]);
  assert.equal(patentPageLeads(items, false).length, items.length);
});
