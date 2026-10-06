# Stark / Friday demo film

78-second, 1920x1080 product film: teach Friday → generated skill → learn with Friday → spotting.

## Review and render

```sh
npx hyperframes preview --background --port 3018
npm run check
npm run render -- --quality delivery --fps 30 --output renders/stark-friday-demo.mp4
```

Studio: http://localhost:3018/#project/stark-friday-demo

## Source capture

From the Project Stark repository root:

```sh
./node_modules/.bin/electron videos/stark-friday-demo/capture.cjs
./node_modules/.bin/electron videos/stark-friday-demo/capture-hub.cjs
```

Captures run in isolated temporary user-data folders. `capture.cjs` uses actual TeachSession, Apprentice, Replay, Lesson and Tutor code, with rehearsed actions in the fictional invoice sandbox. It loads existing Stark credentials securely through src/config; no credentials live here. First capture creates a real AI-generated skill. Subsequent takes reuse that map. Live learner/spotting takes can incur AI charges.

`voiceover.cjs` and `extra-voice.cjs` generate ElevenLabs audio through the configured account (billable). Existing narration files are reused; the actual spotting excerpt is regenerated when requested. `music.cjs` generates the original score locally. See EDIT.md and capture/lesson-evidence.json for provenance and timing.

Existing app data is preserved. The business guide shot intentionally shows a draft with unresolved expert questions; it is not presented as an approved business training release.
