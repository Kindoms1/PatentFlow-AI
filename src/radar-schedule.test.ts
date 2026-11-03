import assert from 'node:assert/strict';
import { test } from 'node:test';
import { radarDue, radarSavedNotice } from './radar-schedule.ts';

test('manual radar schedule never promises an automatic first run', () => {
  assert.equal(radarDue({ enabled: true, schedule: 'manual' }), false);
  assert.match(radarSavedNotice('测试', 'manual'), /立即运行/);
  assert.doesNotMatch(radarSavedNotice('测试', 'manual'), /自动/);
  assert.match(radarSavedNotice('测试', 'daily'), /自动/);
});
