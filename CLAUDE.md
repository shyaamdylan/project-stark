# Project Stark

Friday (learns and teaches tasks) and Jarvis (does them for you) share one orb on the Mac
screen. Electron app: `main.js` wires things together, `src/` holds the logic, `test/` the
unit tests (`npm test`).

## Fix the cause, not the case

Jarvis has to work for any file, app, website or project the user names, not just the one in
today's bug report. When something goes wrong:

- **Find out why it went wrong** before changing anything. Read the run logs
  (`~/Library/Application Support/Project Stark/jarvis-runs/*.json`) and the terminal output,
  and reproduce it with `npm run text` (below).
- **Fix that cause, for every case it covers.** Ask "what else would fail for the same reason?"
  For example, "open the PianoScribe README" found nothing because Spotlight isn't indexing the
  home folder. The fix was a folder-walk fallback for every file search, not special handling
  for READMEs or PianoScribe.
- **Never hard-code the example.** No project names, ports, paths or phrasings from the bug
  report in code, prompts or regexes. Examples in prompts should be generic (`my-app`,
  `localhost:3100`) so Claude doesn't over-fit to them.
- **Prefer giving Jarvis the facts over adding rules for situations.** If he guessed wrong, he
  was usually missing information (what's already running, what a command printed, its exit
  code). Give him that information, rather than another rule about a particular scenario.
- **Add a test for the general behaviour** with made-up names, not the user's real files.

## How Friday teaches

A lesson is `src/tutor.js`: the replay (`src/replay.js`) moves through the Work Map instantly
while the user is on track; the tutor (Claude) is only asked when they go off it, go quiet,
can't find something, or say something. `src/observe.js` gives it the facts: what they clicked,
typed, and which window and field they're in, from the accessibility scan, plus a screenshot of the screen each turn. When
she gets something wrong, give her more of those facts rather than another rule.

At a judgment call or a step with guardrails, what the learner fills in is checked
(`Tutor.judge`) against the expert's decision, reason and guardrails for the case on their
screen before the lesson moves on; a wrong one is stopped and explained in the expert's words.

Tidying a taught skill (`refineMap`) happens once per skill and is saved with `refined`; never
make it run per lesson.

## Conversation memory

`src/convo.js` keeps the last few exchanges (5 minutes, one line each, with what was done:
pointed at X, looked at a screenshot, started a lesson). Every Claude call made for a request
gets it as `turnHistory`, and `followUp()` is checked before a request is sorted into a task, a
question or pointing, so "now the left hand" carries on from "show me the nose". When a reply
looks like it forgot the conversation, check that the call got `turnHistory` and that the
follow-up check ran, rather than adding phrase rules.

## Session logs

Every run writes the terminal output plus the conversation (what was said or typed, what Friday
and Jarvis said, pointed at and did) to
`~/Library/Application Support/Project Stark/logs/session-<time>.log` (last 20 kept; 👀 menu →
"Open this session's log"). When the user sends one, read it before changing anything.

## Testing without voice

Don't spend ElevenLabs credits testing. Use typed mode (voice and mic off, output printed):

```bash
npm run text                                   # interactive
STARK_DRY=1 npm run text -- "Jarvis, …" "yes"  # scripted; clicks/typing/opening only logged
```

It runs alongside the normal app. Drop `STARK_DRY=1` to check something really works end to
end, and say so when you do: it acts on the real screen.

## Safety lines that stay

- Jarvis never types or presses keys in a terminal app. Commands go through `run_command`
  (`src/runproject.js`): only commands the project documents, in its own folder, one at a time,
  with the user's yes, in a visible Terminal window. Deleting, sudo, piping downloads into a
  shell, and system or git-history changes are refused.
- Risky clicks and keys need a yes. Passwords and codes are never typed or read.
- Screenshots (`src/vision.js`): every Claude turn by default (`SCREEN_MODE=always`), of the
  display the front window is on (`SCREEN_AREA=window` for the front window only), with the orb
  kept out (content protection) and a list of which window is where. Pointing can use a screenshot
  box; a click only goes to a control accessibility confirms at that spot (`elementAtPoint`),
  otherwise Jarvis points and asks the user to click. Every look is logged with its reason.
- File access is limited to the home folder, never hidden folders, `~/Library` or
  secret-looking files.
