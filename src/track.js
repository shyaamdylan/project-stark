// Keeping a highlight on the thing it points at after an answer.
//
// The screen keeps changing after Friday or Jarvis points at something: the
// page scrolls, the window moves, the thing goes away. Each fresh scan, find it
// again: by its name for a control, or for part of a picture (which has no
// name of its own) by a named element next to it whose movement it follows.
// null means it's gone, and the highlight should go too.

const { normalize } = require('./matcher');

const center = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const visible = (elements) => (elements || []).filter((e) => !e.hidden && e.w > 0 && e.h > 0);

// The same-named element nearest to where it was.
function relocate(rect, label, elements) {
  const want = normalize(label || '');
  if (!want) return null;
  const c = center(rect);
  const same = visible(elements).filter((e) => normalize(e.label || '') === want);
  if (!same.length) return null;
  return same.sort((a, b) => dist(center(a), c) - dist(center(b), c))[0];
}

// A named element to follow a picture box by: the smallest one containing its
// centre, else the nearest within reach. { label, role, dx, dy } or null.
function anchorFor(rect, elements, reach = 220) {
  const c = center(rect);
  const named = visible(elements).filter((e) => normalize(e.label || ''));
  const holding = named.filter((e) => c.x >= e.x && c.y >= e.y && c.x <= e.x + e.w && c.y <= e.y + e.h && e.w * e.h < 600 * 600);
  const pick = holding.sort((a, b) => a.w * a.h - b.w * b.h)[0] || named.filter((e) => dist(center(e), c) < reach).sort((a, b) => dist(center(a), c) - dist(center(b), c))[0];
  return pick ? { label: pick.label, role: pick.role, x: pick.x, y: pick.y, dx: rect.x - pick.x, dy: rect.y - pick.y } : null;
}

// Where the box is now, following its anchor; null if the anchor's gone.
function followAnchor(rect, anchor, elements) {
  const now = relocate({ x: anchor.x, y: anchor.y, w: 1, h: 1 }, anchor.label, visible(elements).filter((e) => !anchor.role || e.role === anchor.role));
  if (!now) return null;
  return { ...rect, x: now.x + anchor.dx, y: now.y + anchor.dy };
}

const moved = (a, b, px = 3) => Math.abs(a.x - b.x) > px || Math.abs(a.y - b.y) > px || Math.abs(a.w - b.w) > px || Math.abs(a.h - b.h) > px;

module.exports = { relocate, anchorFor, followAnchor, moved };
