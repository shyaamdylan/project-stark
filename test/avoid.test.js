const test = require('node:test');
const assert = require('node:assert');
const { avoid } = require('../src/avoid');

const screen = { x: 0, y: 0, w: 1440, h: 900 };
const island = { w: 320, h: 120, interactive: false };
const run = (steps, dock = null) => {
  let state = {};
  return steps.map(([cursor, now, isl = island]) => {
    const r = avoid({ island: isl, screen, dock, cursor, now }, state);
    state = r.state;
    return r.offset;
  });
};

test('it stays put while the cursor is elsewhere', () => {
  assert.deepEqual(run([[{ x: 300, y: 300 }, 0]]), [{ x: 0, y: 0 }]);
});

test('the cursor coming for the corner moves it straight up, once, and it comes back after the cursor leaves', () => {
  const [a, b, c, d, e] = run([
    [{ x: 1300, y: 860 }, 0], // into the corner
    [{ x: 1300, y: 700 }, 100], // following it to where it went: stays
    [{ x: 1300, y: 860 }, 200], // back over the corner: stays
    [{ x: 400, y: 300 }, 300], // gone
    [{ x: 400, y: 300 }, 1000],
  ]);
  assert.deepEqual(a, { x: 0, y: -134 });
  assert.deepEqual([b, c, d], [a, a, a]);
  assert.deepEqual(e, { x: 0, y: 0 });
});

test("while it's asking something it never runs from the cursor", () => {
  assert.deepEqual(run([[{ x: 1300, y: 860 }, 0, { ...island, interactive: true }]]), [{ x: 0, y: 0 }]);
});

test('a Dock showing over the corner lifts it just clear; one that does not reach the corner leaves it be', () => {
  const wide = { side: 'bottom', autohide: false, rect: { x: 200, y: 830, w: 1150, h: 70 } };
  const narrow = { side: 'bottom', autohide: false, rect: { x: 500, y: 830, w: 440, h: 70 } };
  assert.deepEqual(run([[{ x: 300, y: 300 }, 0]], wide), [{ x: 0, y: -78 }]);
  assert.deepEqual(run([[{ x: 300, y: 300 }, 0]], narrow), [{ x: 0, y: 0 }]);
});

test('an auto-hiding Dock only moves it while the Dock is out', () => {
  const dock = { side: 'bottom', autohide: true, rect: { x: 200, y: 830, w: 1150, h: 70 } };
  const [hidden, shown, stillShown, gone] = run(
    [
      [{ x: 700, y: 500 }, 0],
      [{ x: 700, y: 899 }, 100], // cursor hits the bottom edge over the Dock
      [{ x: 700, y: 850 }, 200], // using the Dock
      [{ x: 700, y: 500 }, 300], // left it
    ],
    dock
  );
  assert.deepEqual(hidden, { x: 0, y: 0 });
  assert.deepEqual(shown, { x: 0, y: -78 });
  assert.deepEqual(stillShown, shown);
  assert.deepEqual(gone, { x: 0, y: 0 });
});

test('a Dock on the right moves it left, along the bottom edge', () => {
  const dock = { side: 'right', autohide: false, rect: { x: 1370, y: 150, w: 70, h: 760 } };
  assert.deepEqual(run([[{ x: 300, y: 300 }, 0]], dock), [{ x: -78, y: 0 }]);
});
