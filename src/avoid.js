// Keeping the corner island clear of the Dock.
//
// When the Dock is showing over the corner (always there, or an auto-hiding
// Dock that's popped up), the island slides along the edge it sits on, just
// far enough to clear it: up from the bottom for a bottom Dock, left for a
// right-hand one. When the Dock hides again, it slides back. Nothing else
// moves it unless it covers the control the assistant is pointing at.

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
function avoid({ island, screen, dock, cursor, target = null, home: suppliedHome = null, nowMs = Date.now() }, state = {}) {
  const s = { dockShown: false, ...state };
  const home = suppliedHome || { x: screen.x + screen.w - island.w, y: screen.y + screen.h - island.h, w: island.w, h: island.h };
  s.dockShown = dockShowing(dock, cursor, screen, s.dockShown);
  let base = { offset: { x: 0, y: 0 }, edge: null, state: s };
  if (s.dockShown && dock.side === 'bottom' && overlapX(home, dock.rect)) base = { offset: { x: 0, y: -(dock.rect.h + GAP) }, edge: 'right', state: s };
  if (s.dockShown && dock.side === 'right' && overlapY(home, dock.rect)) base = { offset: { x: -(dock.rect.w + GAP), y: 0 }, edge: 'bottom', state: s };
  if ((!target || target.w <= 0 || target.h <= 0) && island.yieldToCursor && cursor) {
    const current = {x:home.x+(state.safeOffset?.x||base.offset.x),y:home.y+(state.safeOffset?.y||base.offset.y),w:home.w,h:home.h};
    const onOwnControl = (island.controls || []).some(c => cursor.x >= c.x + (state.safeOffset?.x||base.offset.x) - 12 && cursor.x <= c.x + c.w + (state.safeOffset?.x||base.offset.x) + 12 && cursor.y >= c.y + (state.safeOffset?.y||base.offset.y) - 12 && cursor.y <= c.y + c.h + (state.safeOffset?.y||base.offset.y) + 12);
    if (!onOwnControl && cursor.x >= current.x - 20 && cursor.x <= current.x + current.w + 20 && cursor.y >= current.y - 20 && cursor.y <= current.y + current.h + 20) {
      s.cursorTarget = {x:cursor.x-12,y:cursor.y-12,w:24,h:24}; s.cursorUntil = nowMs+12000;
    }
    if (s.cursorTarget && nowMs < s.cursorUntil) target = s.cursorTarget;
  }
  if (!target || target.w <= 0 || target.h <= 0) return base;
  const blocked = [{ x: target.x - 24, y: target.y - 24, w: target.w + 48, h: target.h + 48 }];
  if (s.dockShown) blocked.push(dock.rect);
  const moved = offset => ({ ...home, x: home.x + offset.x, y: home.y + offset.y });
  const clear = rect => blocked.every(b => !overlapX(rect,b) || !overlapY(rect,b));
  const fits = rect => rect.x >= screen.x && rect.y >= screen.y && rect.x + rect.w <= screen.x + screen.w && rect.y + rect.h <= screen.y + screen.h;
  if (clear(moved(base.offset))) return base;
  // Hold a safe position rather than bouncing between edges as the target moves.
  if (s.safeOffset && clear(moved(s.safeOffset)) && fits(moved(s.safeOffset))) return { offset: s.safeOffset, edge: s.safeEdge, state: s };
  const right = screen.x + screen.w - home.w, bottom = screen.y + screen.h - home.h;
  const candidates = [
    { x: right, y: target.y - home.h - 24, edge: 'right' },
    { x: right, y: target.y + target.h + 24, edge: 'right' },
    { x: target.x - home.w - 24, y: bottom, edge: 'bottom' },
    { x: target.x + target.w + 24, y: bottom, edge: 'bottom' },
    { x: right, y: screen.y, edge: 'right' },
    { x: screen.x, y: bottom, edge: 'bottom' },
    { x: screen.x, y: screen.y, edge: 'left' },
  ].map(c => ({...c, x: Math.max(screen.x, Math.min(right,c.x)), y: Math.max(screen.y, Math.min(bottom,c.y)), w: home.w, h: home.h}));
  const origin = moved(s.safeOffset || base.offset);
  const safe = candidates.filter(c => fits(c) && clear(c)).sort((a,b) => Math.hypot(a.x-origin.x,a.y-origin.y)-Math.hypot(b.x-origin.x,b.y-origin.y))[0];
  if (!safe) return base; // The target may fill the display: do not send the UI off-screen.
  const offset = {x:safe.x-home.x,y:safe.y-home.y};
  return {offset,edge:safe.edge,state:{...s,safeOffset:offset,safeEdge:safe.edge}};
}

module.exports = { avoid, dockShowing };
