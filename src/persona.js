// The two agents that share the orb.
//
//   Friday  learns a task from one person and teaches it to another.
//   Jarvis  does a learned task for you, asking only for what he needs.
//
// Short lines said while waiting are made ahead of time (see prewarmVoice in
// main.js) and sent to the renderer, so both sides use the same lists.

const AGENTS = ['friday', 'jarvis'];

// "Right away{sir}." -> "Right away, sir." (or "Right away." with no form of address).
function addressing(address) {
  const a = String(address || '').trim();
  return (line) => line.replace(/\{sir\}/g, a ? `, ${a}` : '');
}

function persona(agent, cfg) {
  if (agent === 'jarvis') {
    const s = addressing(cfg.jarvis.address);
    return {
      id: 'jarvis',
      name: 'Jarvis',
      title: 'J.A.R.V.I.S.',
      wakeWord: cfg.jarvis.wakeWord,
      address: cfg.jarvis.address,
      greeting: s('Jarvis at your service{sir}. Tell me what you need done.'),
      wakeReply: s('Yes{sir}?'),
      fillers: ['One moment{sir}.', 'Right away.', 'Working on it.', 'Just a moment.', 'Allow me.', 'Bear with me{sir}.', 'Checking now.', 'Very good. One moment.'].map(s),
      acks: ['Very good.', 'Noted{sir}.', 'Understood.', 'Of course.', 'As you wish.', 'Splendid.'].map(s),
      s,
    };
  }
  return {
    id: 'friday',
    name: 'Friday',
    title: 'FRIDAY',
    wakeWord: cfg.wakeWord,
    greeting: `Hi, I'm Friday! Say "Hey Friday" or press ⌘⇧Space and tell me what you need.`,
    wakeReply: 'Yes?',
    fillers: ['Hmm…', 'Let me see…', 'One sec…', 'Okay, let me look…', 'Right…', 'Mm, let me check…', 'Just a moment…', 'Let me think…', 'Okay…', 'Mm-hmm, one second…'],
    acks: ['Got it.', 'Okay, makes sense.', 'Thanks, that helps.', 'Mm, okay.', 'Right, got it.', 'Ah, I see.', 'Okay, noted.', 'Perfect, thanks.'],
    s: (line) => line,
  };
}

// What the renderer needs to know about each agent.
function rendererInfo(cfg) {
  return Object.fromEntries(
    AGENTS.map((id) => {
      const p = persona(id, cfg);
      return [id, { name: p.name, title: p.title, wakeWord: p.wakeWord, wakeReply: p.wakeReply, fillers: p.fillers, acks: p.acks }];
    })
  );
}

module.exports = { AGENTS, persona, rendererInfo, addressing };
