// Seeing the screen through screenshots.
//
// By default (SCREEN_MODE=always) every Claude turn gets a screenshot of the
// screen the front window is on (SCREEN_AREA=window: the front window only),
// with the orb kept out by content protection, plus accessibility's list of
// controls, which gives exact positions for what it describes. In
// SCREEN_MODE=smart, needsVision() decides when a look is worth it. Every look
// is logged with its reason.
//
// Screenshot positions are estimates: they're fine for pointing, but a click
// only goes to an element accessibility confirms at that spot (elementAtPoint).

const { Anthropic } = require('@anthropic-ai/sdk');
const { screenContext } = require('./observe');
const { describeScreen } = require('./guide');

const MODEL = 'claude-opus-5-5';
const RECENT_MS = 2 * 60 * 1000; // follow-ups about something seen keep looking for this long

// Words that say the question is about how something looks.
const VISUAL = /\b(diagram|chart|graph|plot|picture|pic|photo|photograph|image|screenshot|icon|logo|drawing|sketch|map|slide|canvas|figure|illustration|video|frame|thumbnail|colou?r|red|green|blue|yellow|orange|purple|pink|grey|gray|black|white|look(?:s|ing)? like|see (?:in|on) (?:the|this)|shown|shape|arrow|box(?:es)?|circle|highlighted|on the left|on the right|top left|top right|bottom left|bottom right)\b/i;

// Items that are part of the window's own content (not menus or the Dock).
const content = (scan) => ((scan && scan.elements) || []).filter((e) => (e.z || 0) === 0 && !['AXMenuBarItem', 'AXMenuItem', 'AXDockItem'].includes(e.role));

// Should we look? Returns { need, why }.
//   text     what they asked
//   scan     the latest accessibility scan of the front window
//   recent   { key, at } from the last time we looked, if any
//   missed   true when accessibility already came up empty for this request
function needsVision({ text, scan, recent = null, missed = false, now = Date.now() }) {
  if (VISUAL.test(String(text || ''))) return { need: true, why: 'the question is about how something looks' };
  if (missed) return { need: true, why: "accessibility didn't describe what they asked about" };
  const items = content(scan);
  if (scan && !scan.error && items.length < 8) return { need: true, why: `the app describes almost nothing (${items.length} items)` };
  const f = scan && scan.frame;
  if (f && f.w > 0 && f.h > 0) {
    const big = items.find((e) => (e.role === 'AXImage' || e.role === 'AXGroup') && (e.w * e.h) / (f.w * f.h) > 0.35);
    if (big) return { need: true, why: `a large picture or canvas fills the window ("${big.label}")` };
  }
  if (recent && scan && recent.key === `${scan.app}|${scan.window || ''}` && now - recent.at < RECENT_MS) return { need: true, why: 'still talking about something seen in this window' };
  return { need: false, why: '' };
}

// A box on the screenshot, in its own pixels.
const POINT_SCHEMA = {
  anyOf: [
    {
      type: 'object',
      properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' }, label: { type: 'string' } },
      required: ['x', 'y', 'w', 'h', 'label'],
      additionalProperties: false,
    },
    { type: 'null' },
  ],
};

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['answer', 'task'] },
    say: { type: 'string' },
    target_id: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    point: {
      anyOf: [
        {
          type: 'object',
          properties: { x: { type: 'integer' }, y: { type: 'integer' }, w: { type: 'integer' }, h: { type: 'integer' }, label: { type: 'string' } },
          required: ['x', 'y', 'w', 'h', 'label'],
          additionalProperties: false,
        },
        { type: 'null' },
      ],
    },
  },
  required: ['kind', 'say', 'target_id', 'point'],
  additionalProperties: false,
};

const VOICES = {
  friday: 'You are Friday, a warm, clear helper who lives as a glowing orb on their screen.',
  jarvis: (address) => `You are J.A.R.V.I.S., the calm, capable AI butler from Iron Man: polite, concise, with a dry British wit.${address ? ` You address the user as "${address}" now and then.` : ''}`,
};

function system(voice) {
  return `${voice}

You can see a screenshot of their Mac (the whole screen, or the front window when that's all it shows): that's what to go by. They may mean a window that isn't in front, or several at once ("compare these two"); the window list says which is where. You also get the accessibility list (numbered lines "id | role | "label" | app | x,y", in screen points), which gives exact positions for the controls it describes but says nothing about pictures. Vague words ("this", "it", "that box") mean what's on screen.

- kind "answer": answer in one to three short spoken sentences (no markdown or coordinates). If you're talking about a particular thing on screen, point at it: if it's in the list (a button, a field, a link, a menu), give its target_id, which is exact; otherwise (a part of a picture, a diagram, a chart, anything not in the list) give point, its bounding box in the screenshot's own pixels (x, y from the top left, w, h), tight around it, with a short label. Use at most one of the two; both null if there's nothing to point at. Only point at something you can actually see; if it isn't there, say so.
- kind "task": they want something done or walked through step by step rather than explained or shown. say "" and both null.`;
}

// image: { data (base64 JPEG), width, height, frame, area, windows } from snap/capture.
async function lookAtScreen(apiKey, { question, image, scan, agent = 'friday', address = '', history = '', client = null }) {
  const c = client || new Anthropic({ apiKey });
  const voice = agent === 'jarvis' ? VOICES.jarvis(address) : VOICES.friday;
  const list = describeScreen((scan && scan.elements) || [], { withPicture: true });
  const response = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    // Over the 512-token minimum, so repeat calls read it from the prompt cache.
    system: [{ type: 'text', text: system(voice), cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } },
          { type: 'text', text: `${history ? `Recent conversation (read the question in light of it; "now the left hand" carries on from what came before):\n${history}\n\n` : ''}They asked: "${question}"\n\n${screenshotNote(image)}\nWhat's in front of them: ${screenContext(scan)}\n\nAccessibility list:\n${list.text || '(it describes nothing here)'}` },
        ],
      },
    ],
  });
  if (response.stop_reason !== 'end_turn') return { kind: 'task', say: '', target: null, point: null };
  try {
    const r = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    const target = Number.isInteger(r.target_id) ? list.chosen[r.target_id] || null : null;
    return { kind: r.kind === 'answer' ? 'answer' : 'task', say: r.say || '', target, point: target ? null : r.point || null };
  } catch {
    return { kind: 'task', say: '', target: null, point: null };
  }
}

// A screenshot as the image block a message carries.
const imageBlock = (image) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } });

// What a screenshot box lands on: the smallest element accessibility describes
// at its centre, if any. A click only ever goes to an element confirmed this way.
function elementAtPoint(rect, elements) {
  if (!rect) return null;
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const hits = (elements || []).filter((e) => !e.hidden && cx >= e.x && cy >= e.y && cx <= e.x + e.w && cy <= e.y + e.h);
  return hits.sort((a, b) => (a.z || 0) - (b.z || 0) || a.w * a.h - b.w * b.h)[0] || null;
}

// What a screenshot shows, for the prompt: its size, and which window is where
// in it (front first), so "the other window" or "both of these" can be placed.
function screenshotNote(image) {
  if (!image) return '';
  const f = image.frame;
  const head = `Screenshot: ${image.width}×${image.height} pixels, ${image.area === 'screen' ? 'their whole screen' : 'the front window'}.`;
  if (image.area !== 'screen' || !f || !f.w || !f.h) return head;
  const kx = image.width / f.w;
  const ky = image.height / f.h;
  const lines = (image.windows || [])
    .filter((w) => w.x < f.x + f.w && w.y < f.y + f.h && w.x + w.w > f.x && w.y + w.h > f.y)
    .map((w, i) => `${i === 0 ? 'front' : w.float ? 'panel' : 'behind'}: ${w.app}${w.title ? ` "${w.title}"` : ''} at ${Math.round((w.x - f.x) * kx)},${Math.round((w.y - f.y) * ky)} size ${Math.round(w.w * kx)}×${Math.round(w.h * ky)}`);
  return lines.length ? `${head} Windows in it, front first (a window behind can be partly covered):\n${lines.join('\n')}` : head;
}

// A box in screenshot pixels -> a rect in screen points, kept inside the captured area.
function boxToScreen(point, image, frame) {
  if (!point || !image || !frame || !image.width || !image.height) return null;
  const kx = frame.w / image.width;
  const ky = frame.h / image.height;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const x = clamp(frame.x + point.x * kx, frame.x, frame.x + frame.w - 4);
  const y = clamp(frame.y + point.y * ky, frame.y, frame.y + frame.h - 4);
  const w = clamp(Math.max(8, point.w * kx), 8, frame.x + frame.w - x);
  const h = clamp(Math.max(8, point.h * ky), 8, frame.y + frame.h - y);
  return { x, y, w, h, label: point.label || '' };
}

module.exports = { needsVision, lookAtScreen, boxToScreen, elementAtPoint, imageBlock, screenshotNote, POINT_SCHEMA, VISUAL, RECENT_MS };
