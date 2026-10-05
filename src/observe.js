// What the user is doing on screen, as a short running log, without screenshots.
//
// The same way accessibility tools stay aware of the screen: compare each
// accessibility scan with the last (which app and window, which field has the
// keyboard, what changed in each field, menus opening and closing) and pair
// mouse clicks and key presses from the global input hook with the element
// under the pointer. The result reads like a person watching over your
// shoulder: 'clicked button "Export"', 'typed "Q3" into search field "Search"',
// 'now in Numbers — "Budget"'.

const ROLE_WORDS = {
  AXButton: 'button', AXMenuButton: 'menu button', AXPopUpButton: 'dropdown', AXLink: 'link', AXTab: 'tab',
  AXRadioButton: 'option', AXCheckBox: 'checkbox', AXMenuBarItem: 'menu', AXMenuItem: 'menu item',
  AXSearchField: 'search field', AXTextField: 'field', AXTextArea: 'text area', AXComboBox: 'field',
  AXSlider: 'slider', AXCell: 'cell', AXRow: 'row', AXStaticText: 'text', AXImage: 'image', AXDockItem: 'Dock icon',
};
const VALUE_ROLES = new Set(['AXTextField', 'AXSearchField', 'AXComboBox', 'AXPopUpButton', 'AXCheckBox', 'AXRadioButton', 'AXSlider', 'AXTextArea', 'AXIncrementor']);
const CLICKABLE = new Set(['AXButton', 'AXMenuButton', 'AXPopUpButton', 'AXLink', 'AXTab', 'AXRadioButton', 'AXCheckBox', 'AXMenuItem', 'AXMenuBarItem', 'AXCell', 'AXRow', 'AXDisclosureTriangle', 'AXComboBox', 'AXTextField', 'AXSearchField', 'AXTextArea', 'AXDockItem', 'AXStaticText', 'AXImage']);
const MAX_LOG = 60;

const keyOf = (e) => `${e.role}|${e.label}`;
const word = (role) => ROLE_WORDS[role] || 'item';
const short = (v) => {
  const t = String(v ?? '');
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
};
const showValue = (role, v) => (role === 'AXCheckBox' || role === 'AXRadioButton' ? (String(v) === '1' ? 'on' : 'off') : v === '' ? '(empty)' : `"${short(v)}"`);
const inside = (x, y, r) => x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;

class ScreenObserver {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.latest = null;
    this.values = null; // field key -> value
    this.view = null;
    this.focus = null;
    this.menuOpen = false;
    this.log = []; // { t, type, text, ... }
    this.lastInputAt = 0;
  }

  add(ev) {
    const last = this.log[this.log.length - 1];
    // Typing into one field shows up as a run of value changes: keep just the latest.
    if (ev.type === 'edit' && last && last.type === 'edit' && last.key === ev.key && this.now() - last.t < 8000) {
      last.to = ev.to;
      last.t = this.now();
      last.text = ev.text;
      return last;
    }
    const entry = { t: this.now(), ...ev };
    this.log.push(entry);
    if (this.log.length > MAX_LOG) this.log.shift();
    return entry;
  }

  // Feed every scan. Returns the entries it added.
  onScan(scan) {
    if (!scan || scan.error) return [];
    const before = this.log.length;
    const prev = this.latest;
    this.latest = scan;
    const view = `${scan.app}|${scan.window || ''}`;
    const values = new Map();
    for (const e of scan.elements || []) if (VALUE_ROLES.has(e.role) && e.label && 'value' in e) values.set(keyOf(e), { e, v: e.value });

    // Where the keyboard went comes first, so typing that follows reads as one entry.
    const f = scan.focused;
    const focusKey = f ? `${f.role}|${f.label}` : '';
    if (prev && view === this.view && f && focusKey !== this.focus && f.label && (VALUE_ROLES.has(f.role) || f.role === 'AXTextArea')) {
      this.add({ type: 'focus', role: f.role, label: f.label, text: `put the cursor in ${word(f.role)} "${short(f.label)}"` });
    }
    if (prev && view !== this.view) this.add({ type: 'screen', app: scan.app, window: scan.window || '', text: `now in ${scan.app}${scan.window ? ` — "${short(scan.window)}"` : ''}` });
    else if (prev && this.values) {
      for (const [k, { e, v }] of values) {
        const old = this.values.get(k);
        if (old && old.v !== v) this.add({ type: 'edit', key: k, role: e.role, label: e.label, from: old.v, to: v, text: `changed ${word(e.role)} "${short(e.label)}" to ${showValue(e.role, v)}` });
      }
    }
    const menuOpen = (scan.elements || []).some((e) => e.role === 'AXMenuItem' && !e.hidden);
    if (prev && menuOpen !== this.menuOpen) this.add({ type: 'menu', open: menuOpen, text: menuOpen ? 'opened a menu' : 'closed the menu' });
    this.view = view;
    this.values = values;
    this.menuOpen = menuOpen;
    this.focus = focusKey;
    return this.log.slice(before);
  }

  // The smallest clickable thing under the pointer in the latest scan.
  elementAt(x, y) {
    const hits = ((this.latest && this.latest.elements) || []).filter((e) => CLICKABLE.has(e.role) && !e.hidden && inside(x, y, e));
    return hits.sort((a, b) => (a.z || 0) - (b.z || 0) || a.w * a.h - b.w * b.h)[0] || null;
  }

  onClick(x, y) {
    this.lastInputAt = this.now();
    const el = this.elementAt(x, y);
    return this.add(el ? { type: 'click', role: el.role, label: el.label, text: `clicked ${word(el.role)} "${short(el.label)}"` } : { type: 'click', role: null, label: '', text: 'clicked somewhere with nothing labelled' });
  }

  onKey(keys) {
    this.lastInputAt = this.now();
    if (keys) return this.add({ type: 'keys', keys, text: `pressed ${keys}` });
    return null;
  }

  // Everything since `since` (a time), oldest first, as lines.
  since(since) {
    return this.log.filter((e) => e.t > since).map((e) => e.text);
  }

  // Where they are, the file open, where the keyboard is, any selection, in a line.
  where() {
    return screenContext(this.latest);
  }
}

// What "this" most likely means right now, in a line: the front app and
// window, the file it has open, where the keyboard is, and any selected text.
function screenContext(scan) {
  if (!scan || scan.error) return 'unknown';
  const f = scan.focused;
  const bits = [`${scan.app || 'unknown app'}${scan.window ? ` — "${short(scan.window)}"` : ''}`];
  if (scan.document) bits.push(`the file open in it is ${scan.document}`);
  if (f && f.label) bits.push(`typing in ${word(f.role)} "${short(f.label)}"${f.value ? ` (holds "${short(f.value)}")` : ''}`);
  if (scan.selection) bits.push(`selected text: "${scan.selection}"`);
  return bits.join('; ');
}

module.exports = { ScreenObserver, word, screenContext };
