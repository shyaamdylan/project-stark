const test = require('node:test');
const assert = require('node:assert');
const { withStationary, STATIONARY, makeStationary } = require('../src/stationary');

test('stationary is added to the window behaviour, keeping what was there', () => {
  const canJoinAllSpaces = 1 << 0;
  const fullScreenAuxiliary = 1 << 8;
  const b = withStationary(canJoinAllSpaces | fullScreenAuxiliary);
  assert.equal(b & STATIONARY, STATIONARY);
  assert.equal(b & canJoinAllSpaces, canJoinAllSpaces);
  assert.equal(b & fullScreenAuxiliary, fullScreenAuxiliary);
  assert.equal(withStationary(b), b);
});

test('off a Mac it does nothing and never throws', () => {
  if (process.platform === 'darwin') return;
  assert.equal(makeStationary({ isDestroyed: () => false }), false);
});
