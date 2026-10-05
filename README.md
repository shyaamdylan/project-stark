# Project Stark

A small glowing ball of energy that sits in the bottom-right corner of your Mac screen.
It breathes, swirls, and leans its light toward your mouse. Ask it to find a button and a
droplet of it squeezes out, flies across the screen, and turns into a cursor pointing at
the button, while it tells you where it is in an ElevenLabs voice. Then it flies home and
melts back in.

Ask it *how* to do something ("how do I make a new folder?") and it walks you through it
step by step with Claude, hopping to the next button each time you click.

Inspired by [Clicky](https://github.com/farzaa/clicky), but it takes no screenshots: it
reads the real buttons on screen through macOS Accessibility. Finding a button by name
needs no AI at all; walkthroughs send Claude the list of buttons, not an image.

![preview](preview.png)

## Run it (macOS)

You'll need [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone <this repo> project-stark
cd project-stark
npm install
cp .env.example .env   # then paste your ElevenLabs key into .env (optional)
npm start
```

The first time it runs, macOS asks for two permissions. Grant both, then quit and restart
the app:

1. **Accessibility** (System Settings → Privacy & Security → Accessibility). This is what
   lets it read button names and positions. In dev mode the permission goes to your
   **terminal app** (Terminal, iTerm, VS Code), because that's what launched Electron.
2. **Automation → System Events.** Click *OK* on the popup the first time you ask
   for something.

## Using it

- **Click the buddy** or press **⌘⇧Space**, type what you're looking for, and press Enter.
  - `share`, `where's the save button`, `settings tab`, `the file menu`, `search box`
  - Typos are fine: `sned` → *Send*
  - Ask "how do I…" for something you've **taught it** and it walks you through it with the
    expert's steps, reasons and guardrails, moving on as you click. It only guides through
    skills it has learned; for anything else it says it hasn't learned that yet.
- **Say "Hey Friday"** instead of pressing anything, or "Hey Friday, how do I…" in one go.
  The mic listens in the background for the wake word (speech is sent to ElevenLabs to
  check), so it's on by default only when `ELEVENLABS_API_KEY` is set. Toggle it from the 👀
  menu, or set `WAKE_WORD` / `WAKE_WORD_ENABLED` in `.env`.

### Teach it a task (the apprentice)

Type `teach: <what you're about to do>` in the prompt, or pick *Teach me a task…* from the
👀 menu, then just do the task. The buddy watches the front window (fields changing value,
screens changing, what you click) and takes a screenshot at each step. When you pause, it may
ask one short question about a judgment call. Type your answer, or **Skip**. **Off the record**
pauses watching.

**Talk to it.** While it's learning, the mic is always on (needs `ELEVENLABS_API_KEY`):
explain what you're doing as you go and it becomes part of the lesson. Answer its questions out
loud; it sends your answer after a short pause, so take your time. Start talking while it's
speaking and it stops to listen. Say "off the record", "back on the record" or "I'm done".

Press **Finish** (or type `done`). It asks up to three debrief questions, explains the process
back to you, applies your corrections and opens the **Work Map**: a step-by-step tutorial with
the screen moment, the decision, your reason in your own words and the guardrails for each
step. Everything it has learned is in the **Skills Hub** (👀 menu → *Open Skills Hub*):
browse, search, open or delete skills, or teach a new one.

Needs `ANTHROPIC_API_KEY`. The first session asks for microphone access. For screenshots, allow **Screen Recording** for your terminal app
(System Settings → Privacy & Security), then restart it.
- The **👀** in the menu bar has *Ask*, a shortcut to the Accessibility settings, the folder
  for your `.env`, and *Quit*.

It searches every app window you can see on screen, including web pages in Safari, Chrome
and other Chromium browsers, plus the frontmost app's menu bar. Anything hidden behind
another window is skipped, and when two matches are equally good the one nearer the front wins.

## API keys

All keys go in `.env`. See [`.env.example`](.env.example).

| Key | Needed? | What for |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | Optional | The buddy's voice. Without it, the built-in macOS voice is used. |
| `ELEVENLABS_VOICE_ID` | Optional | Which voice to use (defaults to "Jessica", warm and bright). |
| `ELEVENLABS_MODEL_ID` | Optional | Defaults to `eleven_v4_turbo` (expressive and real-time). |
| `ANTHROPIC_API_KEY` | Optional | Step-by-step walkthroughs with Claude (Opus 5.5). Without it, the buddy only finds buttons by name. |
| `OPENAI_API_KEY` | Not used yet | Reserved for anything else you want to add. |
| `VOICE_ENABLED` | Optional | `0` mutes the buddy. |

Keys are only used in the main process and are never sent to the page.
For the packaged app, put `.env` in `~/Library/Application Support/Project Stark/`
(menu bar 👀 → *Open folder for .env*).

## Build a .app

```bash
npm run dist   # → dist/Project Stark-0.1.0.dmg (unsigned)
```

Unsigned builds need right-click → Open the first time. After that, grant Accessibility to
**Project Stark** itself.

## How it works

```
⌘⇧Space / click ──▶ renderer (buddy UI) ──ask──▶ main.js
                                                   │
                                   src/finder.js ──┤ osascript -l JavaScript
                                                   │   src/jxa/list-elements.js
                                                   │   • on-screen windows via CGWindowList
                                                   │   • walk each app's AX tree (AXUIElement)
                                                   │   → [{role,label,app,z,x,y,w,h}, …]
                                   src/matcher.js ─┤ fuzzy match "where's share" → "Share"
                                   src/voice.js  ──┘ ElevenLabs TTS → mp3
                         ◀── rect + line to say ──
orb squeezes out a droplet → spark flies over → becomes the cursor, ring + voice
```

- `main.js` runs a transparent, click-through, always-on-top window over the screen. It
  only accepts clicks while your cursor is over the buddy or its bubble.
- `renderer/` draws the orb with CSS and Web Animations. A gooey SVG filter (blur plus an
  alpha threshold) makes the droplet stretch out of the orb and pinch off. The glow pulses
  with the voice.
- `src/matcher.js` is the fuzzy matcher. Run the tests with `npm test`.
- `src/teach.js` records a teaching session: it diffs a front-window scan every second into
  events, matches clicks (from a global input hook, `uiohook-napi`) to the element under the
  pointer, and decides when you've paused. `src/apprentice.js` asks Claude for questions and
  the Work Map; `src/workmap-page.js` renders the tutorial page.
- `src/guide.js` runs walkthroughs: each turn sends Claude your goal and a numbered list of
  on-screen elements, and gets back one step (what to say, which element to point at).
  `main.js` then watches a cheap screen fingerprint (windows, focus, open menu) to know
  when you've clicked.

## Known limits / ideas

- It doesn't search the Dock, or menu bars of apps that aren't in front.
- Some apps (games, some Java/Qt apps) don't expose accessibility info.
- A Chromium page's tree can be empty the first time. Ask again and it fills in.
- Next steps: push-to-talk voice input, using `ANTHROPIC_API_KEY` to understand vaguer
  requests ("how do I export this?"), and a screenshot + OCR fallback for apps without
  accessibility info.
