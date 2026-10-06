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
   for something. Switching to browser tabs asks once per browser (Safari, Chrome…) too.

## Using it

- **Click the buddy** or press **⌘⇧Space**, type what you're looking for, and press Enter.
  - `share`, `where's the save button`, `settings tab`, `the file menu`, `search box`
  - Typos are fine: `sned` → *Send*
- **Esc** closes the prompt.
- The **👀** in the menu bar has *Ask*, a shortcut to the Accessibility settings, the folder
  for your `.env`, and *Quit*.

It searches the frontmost app's window, including web pages in Safari, Chrome and other
Chromium browsers, and that app's menu bar.

### Switching, opening and finding

The same prompt understands what kind of thing you mean, and prefers whatever is already
open: switching to it is faster than opening a second copy.

| You type | It does |
| --- | --- |
| `switch to slack`, `open slack` | Brings the open Slack window forward (launches Slack if it isn't running) |
| `go to gmail`, `open github.com` | Switches to the tab that's already on that site, otherwise opens it |
| `open the budget spreadsheet`, `open Q3 report.pdf` | Opens the file (Spotlight search, recent files first). If it's already open, switches to it |
| `find my tax return pdf`, `where did I put the invoice` | Reveals the file in Finder |
| `open project stark`, `work on budget-api` | Opens the project folder in your editor |
| `search youtube for lofi`, `google best pizza near me` | Runs the search in your browser |

Words like *file*, *spreadsheet*, *pdf*, *project*, *folder*, *website* and *app* steer the
choice. If something else matched almost as well, it tells you ("Not it? There's also…").
Requests about buttons (`where's the share button`) still point on screen, and a bare word
that isn't on screen (`spotify`) falls back to opening it.

### Workspace

| You type | It does |
| --- | --- |
| `organise my workspace` | Keeps the app you're using, tiles its windows, minimises the rest. Never asks, never closes |
| `organise for coding`, `keep safari and code` | Keeps those apps (profiles: coding, writing, design, email, chat, meeting) |
| `clean up my workspace` | Same, plus asks **once** whether to close windows of safe apps (browsers, Finder, Preview…) |
| `undo`, `put it back` | Restores every moved or minimised window to where it was |

Rules it follows:

- Arranging and minimising are automatic and always undoable.
- Closing only happens after one grouped question listing the windows: answer `yes`,
  `no`, `2`, `1 and 3` or `all but 2`. No answer within 90 seconds means close nothing.
  Windows you don't pick are minimised instead.
- Terminals and edited documents are never closed. Calls (Zoom, FaceTime, Teams, Meet)
  and full-screen windows are never touched.
- If a window asks "Save changes?", it stops closing and leaves the dialog to you.
- Windows it closed can't be reopened by `undo` (in a browser, ⌘⇧T brings them back).
- Removing Mission Control desktops isn't supported yet: macOS has no public API for it, and
  doing it safely means moving windows off a desktop first.

Add your own profiles or closable apps in `.env` (see `JARVIS_*` in `.env.example`).

### Stopping

Type `stop` (or `Jarvis stop`, `Friday stop`, `cancel`, `never mind`), press **Esc**, click the
square **■** button that appears beside the buddy whenever it's talking, working or waiting
for an answer, or choose **Stop** in the 👀 menu. It goes quiet, drops any question it asked
(nothing gets closed), and abandons half-finished work. Either name works as a wake word:
`Jarvis, open slack` / `Friday, switch to mail`.

Hands-free microphone listening isn't built yet; everything above is typed. When it is, stop
will send it back to waiting for "Jarvis" or "Friday".

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
