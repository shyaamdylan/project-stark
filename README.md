# Project Alpha

A little purple buddy that lives at the bottom of your Mac screen. It bobs, blinks and
follows your cursor with its eyes. Ask it to find a button and it walks over, points at
it, and flies a little blue cursor onto it, telling you where it is in an ElevenLabs voice.

Inspired by [Clicky](https://github.com/farzaa/clicky), but much simpler: there's no AI
model and no screenshots. It reads the real buttons on screen through macOS Accessibility.

![preview](preview.png)

## Run it (macOS)

You'll need [Node.js](https://nodejs.org) 20 or newer.

```bash
git clone <this repo> project-alpha
cd project-alpha
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
- **Esc** closes the prompt.
- The **👀** in the menu bar has *Ask*, a shortcut to the Accessibility settings, the folder
  for your `.env`, and *Quit*.

It searches the frontmost app's window, including web pages in Safari, Chrome and other
Chromium browsers, and that app's menu bar.

## API keys

All keys go in `.env`. See [`.env.example`](.env.example).

| Key | Needed? | What for |
| --- | --- | --- |
| `ELEVENLABS_API_KEY` | Optional | The buddy's voice. Without it, the built-in macOS voice is used. |
| `ELEVENLABS_VOICE_ID` | Optional | Which voice to use (defaults to "Rachel"). |
| `ELEVENLABS_MODEL_ID` | Optional | Defaults to `eleven_flash_v2_5` (fast). |
| `ANTHROPIC_API_KEY` | Not used yet | Reserved for smarter natural-language matching. |
| `OPENAI_API_KEY` | Not used yet | Reserved for anything else you want to add. |
| `VOICE_ENABLED` | Optional | `0` mutes the buddy. |

Keys are only used in the main process and are never sent to the page.
For the packaged app, put `.env` in `~/Library/Application Support/Project Alpha/`
(menu bar 👀 → *Open folder for .env*).

## Build a .app

```bash
npm run dist   # → dist/Project Alpha-0.1.0.dmg (unsigned)
```

Unsigned builds need right-click → Open the first time. After that, grant Accessibility to
**Project Alpha** itself.

## How it works

```
⌘⇧Space / click ──▶ renderer (buddy UI) ──ask──▶ main.js
                                                   │
                                   src/finder.js ──┤ osascript -l JavaScript
                                                   │   src/jxa/list-elements.js
                                                   │   • front window owner via CGWindowList
                                                   │   • walk its AX tree via System Events
                                                   │   → [{role,label,x,y,w,h}, …]
                                   src/matcher.js ─┤ fuzzy match "where's share" → "Share"
                                   src/voice.js  ──┘ ElevenLabs TTS → mp3
                         ◀── rect + line to say ──
renderer walks over, raises an arm, flies the blue cursor, draws the highlight ring, talks
```

- `main.js` runs a transparent, click-through, always-on-top window over the screen. It
  only accepts clicks while your cursor is over the buddy or its bubble.
- `renderer/` has the SVG character plus CSS and JS animation (bob, blink, eye tracking,
  walking, pointing).
- `src/matcher.js` is the fuzzy matcher. Run the tests with `npm test`.

## Known limits / ideas

- It only searches the **frontmost** app (plus its menu bar), not the Dock or other windows.
- Some apps (games, some Java/Qt apps) don't expose accessibility info.
- A Chromium page's tree can be empty the first time. Ask again and it fills in.
- Next steps: push-to-talk voice input, using `ANTHROPIC_API_KEY` to understand vaguer
  requests ("how do I export this?"), and a screenshot + OCR fallback for apps without
  accessibility info.
