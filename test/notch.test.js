const test = require('node:test');
const assert = require('node:assert');
const { overlayLayout } = require('../src/notch');

const laptop = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 } };
const monitor = { bounds: { x: 1512, y: 0, width: 2560, height: 1440 }, workArea: { x: 1512, y: 25, width: 2560, height: 1415 } };
const notches = [{ x: 0, w: 1512, left: 662, right: 850, h: 38 }];

test('on a screen with a notch the overlay covers the menu bar and the orb sits in the notch', () => {
  const l = overlayLayout(laptop, notches, 'auto');
  assert.equal(l.mode, 'notch');
  assert.deepEqual(l.area, { x: 0, y: 0, width: 1512, height: 982 });
  assert.deepEqual(l.notch, { x: 662, w: 188, h: 38 });
});

test('a screen without a notch gets the corner island, which covers the whole screen to sit flush in its corner', () => {
  assert.equal(overlayLayout(monitor, notches, 'auto').mode, 'island');
  assert.deepEqual(overlayLayout(monitor, notches, 'corner').area, { x: 1512, y: 0, width: 2560, height: 1440 });
  assert.equal(overlayLayout(monitor, notches, 'float').mode, 'corner');
  assert.deepEqual(overlayLayout(monitor, notches, 'float').area, monitor.workArea);
  const forced = overlayLayout(monitor, notches, 'notch');
  assert.equal(forced.mode, 'notch');
  assert.deepEqual(forced.notch, { x: 1190, w: 180, h: 25 });
  assert.equal(overlayLayout(laptop, notches, 'corner').mode, 'island');
});
