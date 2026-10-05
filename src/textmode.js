// Typed, silent mode for trying requests without a microphone or ElevenLabs:
//
//   npm run text                                   type requests (and answers) at a prompt
//   npm run text -- "Jarvis, open the PianoScribe readme" "yes"
//                                                  run these lines in order, then quit
//   STARK_DRY=1 npm run text -- "…"                same, but clicks, typing and opening
//                                                  things are only logged, not done
//
// Every line is a request, unless Jarvis or Friday is waiting on an answer, in
// which case it's the answer. Everything they'd say is printed instead of
// spoken, and the microphone stays off.

const readline = require('readline');

const enabled = () => process.argv.includes('--text') || process.env.STARK_TEXT === '1';
const dryRun = () => process.env.STARK_DRY === '1';

// Lines given after --text, or none (then they're read from the terminal).
function scriptedLines(argv = process.argv) {
  const i = argv.indexOf('--text');
  return i >= 0 ? argv.slice(i + 1).filter((x) => !x.startsWith('--')) : [];
}

const out = (tag, text) => console.log(`\n  ${tag} ${text}`);

// What the orb would show or say, printed.
function logSend(channel, payload) {
  const p = payload || {};
  if (channel === 'say' && p.text) out('💬', p.text);
  else if (channel === 'jarvis-step' && p.say) out(p.quiet ? '  ·' : '💬', p.say);
  else if (channel === 'jarvis-step' && p.label) out('  👉', `pointing at "${p.label}"`);
  else if (channel === 'jarvis-state' && !p.running) out(p.status === 'done' ? '✅' : '⏹', `${p.say || ''} [${p.status}]`);
  else if (channel === 'guide-step' && p.say) out('💬', p.say);
}

// deps:
//   handleAsk(text) -> the same reply the orb gets
//   busy()          true while a Jarvis run is going
//   quit()
//   lessonSay(text) -> true if a lesson is running and took the line as part of it
function createTextMode({ handleAsk, busy, quit, lessonSay = () => false }) {
  const queue = scriptedLines();
  const scripted = queue.length > 0;
  let waiting = null; // resolves the open question with the next line
  let rl = null;

  const next = () =>
    new Promise((resolve) => {
      if (queue.length) return resolve(queue.shift());
      if (scripted) return resolve(null);
      rl.question('\n> ', (line) => resolve(line));
    });

  // Replaces askUser: a question takes the next line as its answer.
  async function askUser(text, phase) {
    out('❓', `${text}  (${phase})`);
    const answer = waiting ? '' : await new Promise((resolve) => {
      waiting = resolve;
    });
    return answer;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function run() {
    if (!scripted) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('close', () => queue.push(null));
      console.log('\nText mode: type a request ("Jarvis, open the PianoScribe readme"), or an answer when asked. Ctrl-D quits.');
    }
    let pending = null; // the request in progress
    for (;;) {
      // Wait until something needs a line: a question, or nothing running.
      while (!waiting && (pending || busy())) {
        await sleep(100);
        if (pending && pending.done && !busy()) pending = null;
      }
      const line = await next();
      if (line == null) {
        if (waiting) {
          // Out of lines with a question open: skip it, and let the run finish.
          const w = waiting;
          waiting = null;
          out('↩', '(no answer)');
          w('');
          continue;
        }
        break;
      }
      if (!line.trim()) continue;
      out('🧑', line);
      if (waiting) {
        const w = waiting;
        waiting = null;
        w(line);
        continue;
      }
      // Mid-lesson, a line is something said to Friday, not a new request.
      if (lessonSay(line)) continue;
      const started = Date.now();
      pending = { done: false };
      const p = pending;
      handleAsk(line).then((res) => {
        if (res && !res.jarvis) {
          if (res.clarify) out('❓', `${res.question}  (clarify: answer with your next line as a new request)`);
          else if (res.say) out(res.ok === false ? '⚠️' : '💬', res.say);
          if (res.label) out('  👉', `pointing at "${res.label}"`);
        }
        out('⏱', `${((Date.now() - started) / 1000).toFixed(1)}s`);
        p.done = true;
      }, (err) => {
        out('💥', err.message);
        p.done = true;
      });
      await sleep(50);
    }
    if (rl) rl.close();
    quit();
  }

  return { askUser, run };
}

module.exports = { enabled, dryRun, scriptedLines, logSend, createTextMode };
