const test = require('node:test');
const assert = require('node:assert');
const { relocate, anchorFor, followAnchor, moved } = require('../src/track');

const el = (label, x, y, extra = {}) => ({ role: 'AXButton', label, x, y, w: 80, h: 24, ...extra });

test('a pointed-at control is found again after it moves, and reported gone when it is', () => {
  const was = el('Export', 100, 100);
  const now = relocate(was, 'Export', [el('Export', 100, 40), el('Export', 900, 700), el('Cancel', 100, 100)]);
  assert.deepEqual([now.x, now.y], [100, 40]); // the nearer of the two
  assert.equal(moved(now, was), true);
  assert.equal(relocate(was, 'Export', [el('Cancel', 100, 100)]), null);
});

test('part of a picture follows the named element it sits in when the page scrolls', () => {
  const box = { x: 220, y: 260, w: 40, h: 30, label: 'Left ventricle' };
  const figure = el('Heart diagram', 150, 200, { role: 'AXImage', w: 300, h: 300 });
  const anchor = anchorFor(box, [figure, el('Next', 600, 600)]);
  assert.equal(anchor.label, 'Heart diagram');
  const after = followAnchor(box, anchor, [{ ...figure, y: 80 }]);
  assert.deepEqual([after.x, after.y, after.label], [220, 140, 'Left ventricle']);
  assert.equal(followAnchor(box, anchor, [el('Next', 600, 600)]), null);
});

const { sceneShift, follow } = require('../src/track');
const page = (dy, extra = []) => [el('Title', 40, 20 + dy), el('Save', 600, 20 + dy), el('Edit', 100, 300 + dy), el('Edit', 100, 700 + dy), el('Total', 400, 500 + dy), ...extra];

test('a scroll moves the pointer with the page, onto the same thing', () => {
  assert.deepEqual(sceneShift(page(0), page(-120)), { dx: 0, dy: -120, n: 3 });
  const now = follow(el('Edit', 100, 300), 'Edit', page(0), page(-120));
  assert.deepEqual([now.x, now.y], [100, 180]);
});

test("scrolled out of sight: it's gone, not the other button with the same name", () => {
  const before = page(0);
  const after = page(-400).filter((e) => e.y > 0); // the first Edit scrolled off the top
  assert.equal(follow(el('Edit', 100, 300), 'Edit', before, after), null);
});

test('part of a picture moves with the page, and goes when nothing agrees on how it moved', () => {
  const box = { x: 300, y: 400, w: 40, h: 30, label: 'Left ventricle' };
  const now = follow(box, '', page(0), page(-50));
  assert.deepEqual([now.x, now.y, now.label], [300, 350, 'Left ventricle']);
  assert.equal(follow(box, '', page(0), [el('Something else', 10, 10)]), null);
});
