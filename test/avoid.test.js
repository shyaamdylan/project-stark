const test = require('node:test');
const assert = require('node:assert');
const { avoid } = require('../src/avoid');

const screen = { x: 0, y: 0, w: 1440, h: 900 };
const island = { w: 320, h: 120 };
const run = (steps, dock = null) => {
  let state = {};
  return steps.map((cursor) => {
    const r = avoid({ island, screen, dock, cursor }, state);
    state = r.state;
    return [r.offset, r.edge];
  });
};

test('the cursor never moves it, even right over it', () => {
  assert.deepEqual(run([{ x: 1300, y: 860 }]), [[{ x: 0, y: 0 }, null]]);
});

test('a Dock showing over the corner lifts it just clear, flush to the right edge; one that does not reach the corner leaves it be', () => {
  const wide = { side: 'bottom', autohide: false, rect: { x: 200, y: 830, w: 1150, h: 70 } };
  const narrow = { side: 'bottom', autohide: false, rect: { x: 500, y: 830, w: 440, h: 70 } };
  assert.deepEqual(run([{ x: 300, y: 300 }], wide), [[{ x: 0, y: -78 }, 'right']]);
  assert.deepEqual(run([{ x: 300, y: 300 }], narrow), [[{ x: 0, y: 0 }, null]]);
});

test('an auto-hiding Dock only moves it while the Dock is out', () => {
  const dock = { side: 'bottom', autohide: true, rect: { x: 200, y: 830, w: 1150, h: 70 } };
  const [hidden, shown, stillShown, gone] = run([{ x: 700, y: 500 }, { x: 700, y: 899 }, { x: 700, y: 850 }, { x: 700, y: 500 }], dock);
  assert.deepEqual(hidden[0], { x: 0, y: 0 });
  assert.deepEqual(shown[0], { x: 0, y: -78 });
  assert.deepEqual(stillShown, shown);
  assert.deepEqual(gone[0], { x: 0, y: 0 });
});

test('a Dock on the right moves it left, flush to the bottom edge', () => {
  const dock = { side: 'right', autohide: false, rect: { x: 1370, y: 150, w: 70, h: 760 } };
  assert.deepEqual(run([{ x: 300, y: 300 }], dock), [[{ x: -78, y: 0 }, 'bottom']]);
});
