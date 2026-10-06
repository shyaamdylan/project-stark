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
