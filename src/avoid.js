// Keeping the corner island out of the way: of the Dock when it's showing over
// the corner, and of the cursor when it comes for something underneath.
//
// Movement is kept to a minimum: the island only ever slides along the edge it
// sits on (up from the bottom, or left from a right-hand Dock), as far as it
// needs to and no further, and it comes back only once the cursor has left
// both where it was and where it went. While it's asking something (a question
// with buttons, a box to type in) it stays put so it can be answered.

const MARGIN = 14; // how close the cursor gets before it counts as "coming for it"
const GAP = 8; // space left between the island and the Dock
const RETURN_MS = 600; // the cursor has to stay away this long before it comes back

const inside = (p, r, m = 0) => p.x >= r.x - m && p.y >= r.y - m && p.x <= r.x + r.w + m && p.y <= r.y + r.h + m;
const overlapX = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w;
const overlapY = (a, b) => a.y < b.y + b.h && b.y < a.y + a.h;
const shift = (r, o) => ({ ...r, x: r.x + o.x, y: r.y + o.y });

// Is an auto-hiding Dock showing? It pops up when the cursor reaches its edge
// over it, and hides once the cursor moves well away.
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

// One tick. island: { w, h, interactive } (its size now); screen: the display
// rect { x, y, w, h }; dock: { side, autohide, rect } or null; cursor: { x, y };
// state from the last tick (start with {}). Returns { offset: { x, y }, state }.
function avoid({ island, screen, dock, cursor, now = Date.now() }, state = {}) {
  const s = { fled: false, outSince: 0, dockShown: false, ...state };
  const home = { x: screen.x + screen.w - island.w, y: screen.y + screen.h - island.h, w: island.w, h: island.h };

  // Clear of the Dock, if it's showing over the corner.
  s.dockShown = dockShowing(dock, cursor, screen, s.dockShown);
  const base = { x: 0, y: 0 };
  if (s.dockShown && dock && dock.rect) {
    if (dock.side === 'bottom' && overlapX(home, dock.rect)) base.y = -(dock.rect.h + GAP);
    if (dock.side === 'right' && overlapY(home, dock.rect)) base.x = -(dock.rect.w + GAP);
  }
  const rest = shift(home, base);

  // Out of the cursor's way: straight up by its own height.
  const away = { x: base.x, y: base.y - (island.h + MARGIN) };
  const fledTo = shift(home, away);
  if (island.interactive) {
    s.fled = false;
    s.outSince = 0;
  } else if (!s.fled) {
    if (inside(cursor, rest, MARGIN)) {
      s.fled = true;
      s.outSince = 0;
    }
  } else if (inside(cursor, rest, MARGIN) || inside(cursor, fledTo, MARGIN)) {
    s.outSince = 0; // still around it (or using it where it went): stay
  } else if (!s.outSince) {
    s.outSince = now;
  } else if (now - s.outSince >= RETURN_MS) {
    s.fled = false;
    s.outSince = 0;
  }
  return { offset: s.fled ? away : base, state: s };
}

module.exports = { avoid, dockShowing };
