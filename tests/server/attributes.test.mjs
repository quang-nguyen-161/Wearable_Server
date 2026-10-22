// tests/server/attributes.test.mjs
// Unit & Integration Tests for Attribute Store Fallback and Persistence

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setDeviceAttributes,
  getDeviceAttributes,
  getAllDeviceAttributes,
} from '../../lib/server/attributeStore.mjs';

test('T16-ATTR-STORE-1: setDeviceAttributes and getAllDeviceAttributes per scope', () => {
  const devId = 'tb-dev-test-attr-01';

  setDeviceAttributes(devId, 'SHARED_SCOPE', { showEcg: 0, deviceMode: 1 });
  setDeviceAttributes(devId, 'SERVER_SCOPE', { hrMin: 55, hrMax: 115 });

  const shared = getDeviceAttributes(devId, 'SHARED_SCOPE');
  assert.equal(shared.showEcg, 0);
  assert.equal(shared.deviceMode, 1);

  const server = getDeviceAttributes(devId, 'SERVER_SCOPE');
  assert.equal(server.hrMin, 55);
  assert.equal(server.hrMax, 115);

  const all = getAllDeviceAttributes(devId);
  assert.equal(all.showEcg, 0);
  assert.equal(all.deviceMode, 1);
  assert.equal(all.hrMin, 55);
  assert.equal(all.hrMax, 115);
});

test('T16-ATTR-STORE-2: Overwrite single key preserves other attributes in same scope', () => {
  const devId = 'tb-dev-test-attr-02';

  setDeviceAttributes(devId, 'SHARED_SCOPE', { showEcg: 1, deviceMode: 0 });
  setDeviceAttributes(devId, 'SHARED_SCOPE', { showEcg: 0 }); // toggle ECG off

  const shared = getDeviceAttributes(devId, 'SHARED_SCOPE');
  assert.equal(shared.showEcg, 0, 'showEcg should be updated to 0');
  assert.equal(shared.deviceMode, 0, 'deviceMode should be preserved');
});
