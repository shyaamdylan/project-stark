const test = require('node:test');
const assert = require('node:assert');
const { Conversation } = require('../src/convo');

const WIN = 'Safari|human body - Google Search';

function body(now) {
  const c = new Conversation({ now: () => now.t });
  c.add('user', "I've got a diagram on screen. I'll ask you to show me parts of the body, and I want you to point to them. Can you show me the nose");
  c.add('friday', "Here's the nose, right in the center of the face.", { mode: 'look', target: 'Nose', window: WIN });
  return c;
}

test('"can you now show me the left hand" carries on from looking at the diagram', () => {
  const now = { t: 1_000_000 };
  const c = body(now);
  now.t += 20_000;
  assert.equal(c.followUp('Can you now show me the left hand', WIN), 'look');
  assert.equal(c.followUp('and the knee?', WIN), 'look');
  assert.equal(c.followUp('what about the right foot', WIN), 'look');
});

test('a new kind of request, another window, or a long pause is not a follow-up', () => {
  const now = { t: 1_000_000 };
  const c = body(now);
  now.t += 20_000;
  assert.equal(c.followUp('open my downloads', WIN), null);
  assert.equal(c.followUp('how do I export this', WIN), null);
  assert.equal(c.followUp('show me the knee', 'Finder|Recents'), null);
  now.t += 5 * 60_000;
  assert.equal(c.followUp('show me the knee', WIN), null);
});

test('the history for prompts is short, one line per turn, and says what was done', () => {
  const now = { t: 1_000_000 };
  const c = body(now);
  const h = c.forPrompt();
  assert.equal(h.split('\n').length, 2);
  assert.match(h, /^You: I've got a diagram/);
  assert.match(h, /Friday: Here's the nose.* \[pointed at "Nose" in a screenshot\]$/);
  for (let i = 0; i < 20; i++) c.add('user', 'x'.repeat(300));
  assert.ok(c.forPrompt().length <= 900);
  assert.ok(c.forPrompt().split('\n').every((l) => l.length <= 170));
});
