// Keeping the corner island clear of the Dock.
//
// When the Dock is showing over the corner (always there, or an auto-hiding
// Dock that's popped up), the island slides along the edge it sits on, just
// far enough to clear it: up from the bottom for a bottom Dock, left for a
// right-hand one. When the Dock hides again, it slides back. Nothing else
// moves it.

const GAP = 8; // space left between the island and the Dock

const overlapX = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
const overlapY = (a, b) => a.y < b.y + b.h && b.y < a.y + a.h;

// Is the Dock showing? An auto-hiding one pops up when the cursor reaches its
// edge over it, and hides once the cursor moves well away.
function dockShowing(dock, cursor, screen, wasShowing) {
  if (!dock || !dock.rect) return false;
  if (!dock.autohide) return true;
  const r = dock.rect;
  if (dock.side === 'bottom') {
    if (cursor.y >= screen.y + screen.h - 2 && cursor.x >= r.x && cursor.x <= r.x + r.w) return true;
    return wasShowing && cursor.y >= screen.y + screen.h - r.h - 24;
  }
  if (dock.side === 'right') {
    if (cursor.x >= screen.x + screen.w - 2 && cursor.y >= r.y && cursor.y <= r.y + r.h) return true;
    return wasShowing && cursor.x >= screen.x + screen.w - r.w - 24;
  }
  if (cursor.x <= screen.x + 1 && cursor.y >= r.y && cursor.y <= r.y + r.h) return true;
  return wasShowing && cursor.x <= screen.x + r.w + 24;
}

// One tick. island: { w, h } (its size now); screen: the display { x, y, w, h };
// dock: { side, autohide, rect } or null; cursor: { x, y } (for an auto-hiding
// Dock); state from the last tick (start with {}). Returns { offset, edge, state }:
// edge is the screen edge it stays flush against while moved ('right' or
// 'bottom'), or null when it's home in the corner.
function avoid({ island, screen, dock, cursor }, state = {}) {
  const s = { dockShown: false, ...state };
  const home = { x: screen.x + screen.w - island.w, y: screen.y + screen.h - island.h, w: island.w, h: island.h };
  s.dockShown = dockShowing(dock, cursor, screen, s.dockShown);
  if (s.dockShown && dock.side === 'bottom' && overlapX(home, dock.rect)) return { offset: { x: 0, y: -(dock.rect.h + GAP) }, edge: 'right', state: s };
  if (s.dockShown && dock.side === 'right' && overlapY(home, dock.rect)) return { offset: { x: -(dock.rect.w + GAP), y: 0 }, edge: 'bottom', state: s };
  return { offset: { x: 0, y: 0 }, edge: null, state: s };
}

module.exports = { avoid, dockShowing };
