// Looking at the screen, only when the accessibility description isn't enough.
//
// Normally Friday and Jarvis read the screen as text through accessibility:
// exact, private, no screen recording. That's blind to pictures (diagrams,
// photos, charts, design canvases, games). So when it's needed, and only then,
// they take one screenshot of the front window (the orb hidden) and ask Claude
// about it, getting back an answer and a box to point at. needsVision() decides
// when; the reason is always logged.
//
// A screenshot is only ever used to answer and to point, never to click: its
// positions are estimates, not the exact frames accessibility gives.

const { Anthropic } = require('@anthropic-ai/sdk');
const { screenContext } = require('./observe');

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

const SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['answer', 'task'] },
    say: { type: 'string' },
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
  required: ['kind', 'say', 'point'],
  additionalProperties: false,
};

const VOICES = {
  friday: 'You are Friday, a warm, clear helper who lives as a glowing orb on their screen.',
  jarvis: (address) => `You are J.A.R.V.I.S., the calm, capable AI butler from Iron Man: polite, concise, with a dry British wit.${address ? ` You address the user as "${address}" now and then.` : ''}`,
};

function system(voice) {
  return `${voice}

You're looking at a screenshot of the front window on their Mac, because what they asked needs seeing (a diagram, picture, chart, canvas, or something the app doesn't describe as text). Vague words ("this", "it", "that box") mean what's on screen.

- kind "answer": answer in one to three short spoken sentences (no markdown or coordinates). If you're talking about a particular part of the image (a box in a diagram, a bar in a chart, a button), point at it: point is its bounding box in the screenshot's own pixels (x, y from the top left, w, h), tight around it, with a short label. Otherwise point is null. Only point at something you can actually see; if it isn't there, say so.
- kind "task": they want something done rather than explained or shown. say "" and point null.`;
}

// image: { data (base64 JPEG), width, height } of the front window only.
async function lookAtScreen(apiKey, { question, image, scan, agent = 'friday', address = '', client = null }) {
  const c = client || new Anthropic({ apiKey });
  const voice = agent === 'jarvis' ? VOICES.jarvis(address) : VOICES.friday;
  const response = await c.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: system(voice),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image.data } },
          { type: 'text', text: `They asked: "${question}"\n\nThe screenshot is ${image.width}×${image.height} pixels. What's in front of them: ${screenContext(scan)}` },
        ],
      },
    ],
  });
  if (response.stop_reason !== 'end_turn') return { kind: 'task', say: '', point: null };
  try {
    const r = JSON.parse(response.content.filter((b) => b.type === 'text').map((b) => b.text).join(''));
    return { kind: r.kind === 'answer' ? 'answer' : 'task', say: r.say || '', point: r.point || null };
  } catch {
    return { kind: 'task', say: '', point: null };
  }
}

// A box in screenshot pixels -> a rect in screen points, kept inside the window.
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

module.exports = { needsVision, lookAtScreen, boxToScreen, VISUAL, RECENT_MS };
