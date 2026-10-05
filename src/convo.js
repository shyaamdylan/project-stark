// A short memory of the conversation, so a follow-up is understood in light of
// what came before ("I'll ask you to point at parts of the body" ... "now the
// left hand").
//
// Kept small on purpose: the last few exchanges from the past few minutes, each
// one line, with what was done (pointed at "Nose" in a screenshot, started a
// lesson). That's all a follow-up needs, and it costs a few hundred tokens.

const MAX_TURNS = 8;
const MAX_AGE_MS = 5 * 60 * 1000;
const FOLLOW_UP_MS = 2 * 60 * 1000;
const NAMES = { user: 'You', friday: 'Friday', jarvis: 'Jarvis' };

const oneLine = (t, max = 160) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

// A request that starts something new, rather than carrying on with the last thing.
const NEW_THING = /^(?:(?:hey|ok(?:ay)?|so)[\s,]+)?(?:(?:can|could|would) you\s+)?(?:please\s+)?(open|launch|go to|switch to|bring up|teach|learn|let me show you|watch me|how (?:do|can|would|should) i|walk me|guide me|start|create|make|send|close|quit|stop|search|type|press|click|play|download|install)\b/i;
// Phrasing that carries on: "now the left hand", "and the knee?", "what about X", "show me X".
const CARRY_ON = /^(?:(?:hey|ok(?:ay)?|so|and|now|also|then|right|great|cool|nice)[\s,]+)*(?:(?:can|could|would) you\s+)?(?:now\s+|also\s+|please\s+|just\s+)*(show|point|where|which|what|how about|and|the|that|this|those|these|find|highlight|circle|is|are|does|do)\b/i;

class Conversation {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.turns = []; // { t, who, text, mode, target, window }
  }

  // who: 'user' | 'friday' | 'jarvis'. mode (assistant turns): 'look' (answered
  // from a screenshot), 'point', 'answer', 'lesson', 'task', 'file', 'none'.
  add(who, text, { mode = 'none', target = '', window = '' } = {}) {
    if (!String(text || '').trim() && !target && mode === 'none') return;
    this.turns.push({ t: this.now(), who, text: oneLine(text), mode, target: oneLine(target, 60), window });
    if (this.turns.length > MAX_TURNS) this.turns.shift();
  }

  recent() {
    const since = this.now() - MAX_AGE_MS;
    return this.turns.filter((x) => x.t >= since);
  }

  // The last thing Friday or Jarvis did, if it was recent.
  lastReply(withinMs = FOLLOW_UP_MS) {
    const r = this.recent().filter((x) => x.who !== 'user');
    const last = r[r.length - 1];
    return last && this.now() - last.t <= withinMs ? last : null;
  }

  // Is this request carrying on with what was just done in this window? Returns
  // that mode ('look', 'point', 'answer') or null.
  followUp(text, windowKey) {
    const last = this.lastReply();
    if (!last || !['look', 'point', 'answer'].includes(last.mode)) return null;
    if (last.window && windowKey && last.window !== windowKey) return null;
    const t = String(text || '').trim();
    if (NEW_THING.test(t)) return null;
    const short = t.split(/\s+/).length <= 8;
    return CARRY_ON.test(t) || short ? last.mode : null;
  }

  // The recent conversation as a few lines for a prompt, oldest first. '' if none.
  forPrompt(maxChars = 900) {
    const lines = this.recent().map((x) => {
      const did = x.mode === 'look' ? ` [pointed at "${x.target}" in a screenshot]` : x.mode === 'point' && x.target ? ` [pointed at "${x.target}"]` : x.mode === 'lesson' ? ' [started a walkthrough]' : x.mode === 'task' ? ' [started doing it]' : '';
      return `${NAMES[x.who] || x.who}: ${x.text}${x.mode === 'look' && !x.target ? ' [looked at a screenshot]' : did}`;
    });
    // The current request is the last user line: the caller sends it separately.
    while (lines.length && lines.join('\n').length > maxChars) lines.shift();
    return lines.join('\n');
  }
}

module.exports = { Conversation, NEW_THING, CARRY_ON };
