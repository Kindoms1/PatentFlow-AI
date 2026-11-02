import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

test('production secret helper refuses to promote a local test configuration', () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'patentflow-secret-test-'));
  try {
    fs.writeFileSync(path.join(root,'.env.local'),'AGNES_API_KEY=synthetic-development-key');
    const result=spawnSync(process.execPath,[path.resolve('scripts/cf-secrets.mjs')],{cwd:root,encoding:'utf8',env:{...process.env,PATH:''},timeout:5000});
    assert.notEqual(result.status,0);
    assert.match(result.stdout+result.stderr,/缺少.*\.env\.production\.local/);
    assert.doesNotMatch(result.stdout+result.stderr,/synthetic-development-key/);
  } finally {
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));
    fs.rmSync(root,{recursive:true,force:true});
  }
});
