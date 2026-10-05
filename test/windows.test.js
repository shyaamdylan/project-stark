const test = require('node:test');
const assert = require('node:assert');
const { rankOpen, describe, pickWithClaude } = require('../src/windows');

const open = {
  windows: [
    { kind: 'window', pid: 1, index: 0, app: 'Numbers', title: 'Q3 Budget.numbers', minimized: true },
    { kind: 'window', pid: 2, index: 0, app: 'Mail', title: 'Inbox – 12 messages' },
    { kind: 'window', pid: 3, index: 0, app: 'Finder', title: 'Downloads' },
  ],
  tabs: [
    { kind: 'tab', app: 'Google Chrome', window: 1, tab: 3, title: 'Weekly sync - Google Meet', url: 'https://meet.google.com/abc-defg-hij' },
    { kind: 'tab', app: 'Safari', window: 1, tab: 1, title: 'YouTube', url: 'https://www.youtube.com/' },
  ],
};

test('names match windows (minimised too), apps and tabs', () => {
  assert.equal(rankOpen('budget', open)[0].item.title, 'Q3 Budget.numbers');
  assert.equal(rankOpen('the mail window', open)[0].item.app, 'Mail');
  assert.equal(rankOpen('youtube', open)[0].item.title, 'YouTube');
  assert.equal(rankOpen('google meet', open)[0].item.kind, 'tab');
  assert.deepEqual(rankOpen('spreadsheet about llamas', open).filter((x) => x.score >= 0.6), []);
});

test('said out loud naturally', () => {
  assert.equal(describe(open.windows[0]), 'Q3 Budget.numbers in Numbers');
  assert.equal(describe(open.tabs[1]), 'the YouTube tab in Safari');
  assert.equal(describe({ kind: 'window', app: 'Slack', title: 'Slack' }), 'Slack');
});

function fakeClient(reply) {
  const sent = [];
  return {
    sent,
    beta: { messages: { create: async (req) => (sent.push(req), { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(reply) }] }) } },
  };
}

test('"the window I had the meeting in": Claude picks from what is open', async () => {
  const c = fakeClient({ match: 'one', ids: [3] });
  const r = await pickWithClaude('k', 'the window I had the meeting open in', open, c);
  assert.equal(r.match, 'one');
  assert.equal(r.items[0].title, 'Weekly sync - Google Meet');
  assert.match(c.sent[0].messages[0].content, /3 \| tab \| Google Chrome \| "Weekly sync - Google Meet" \| meet\.google\.com/);
});

test('ids outside the list are ignored; several becomes a choice', async () => {
  const none = await pickWithClaude('k', 'x', open, fakeClient({ match: 'one', ids: [99] }));
  assert.equal(none.match, 'none');
  const two = await pickWithClaude('k', 'x', open, fakeClient({ match: 'several', ids: [0, 2] }));
  assert.equal(two.match, 'several');
  assert.equal(two.items.length, 2);
});
