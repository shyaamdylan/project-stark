# Capture and edit notes
Actual Stark renderers captured in an isolated Electron process. Expert actions and narration collected by TeachSession. The Apprentice generated capture/learned-skill.json with live AI. Real Lesson, Replay and Tutor modules drove guidance and spotting, using DOM-derived accessibility equivalents and actual sandbox screenshots.

Pointer/typing inputs were rehearsed in the fictional Ledra invoice sandbox. This is a working-engine demonstration, not a production customer session. Existing user recordings and workspaces were preserved.

Teach retimed to15s; learning to18s. Spotting's quiet opening is retimed to9s, the actual flag to9s, and completed correction actions to6s. Both lesson runs reached the real engine's done state before capture ended. No response-speed claim. Friday's audio excerpts come from actual emitted replies and are resynthesised with the configured ElevenLabs voice. Remaining narration is scripted ElevenLabs. music.cjs generates the original bright major-key score at 108 BPM. Jessica voices Friday and the ad narration; Chris voices the expert; Sarah voices the learner. Learner requests are scripted demo dialogue. Bundled HyperFrames soft-click, short-whoosh and chime assets accent screen actions, chapter changes and completion. The score is spectrally carved around all 14 speech clips at strength 0.5.

The guide shown in the business workspace remains a draft because open questions require expert confirmation. The recording itself works with the original local lesson engine. No second-expert or setup form walkthrough. Runtime78s gives spotting room to breathe.

The final two seconds of learning and final 1.5 seconds of spotting use closeups of the actual recorded completion state. These are crops of source footage.

Audio revision requested by the user: distinct expert/learner/Friday roles, brighter music, and restrained UI sound design. Run revise-audio.cjs, music.cjs, assemble.cjs, then the HyperFrames audio carve script before rendering; assemble.cjs replaces the root mix attributes.

The expert opens at 4.2s after the first narration: “Hey Friday, here’s how to review and code a machinery invoice.” This scripted command uses Chris, matching the subsequent expert teaching.

Learning/spotting distinction: learning has three numbered editorial captions below the captured application and matching Friday speech. Spotting has no numbered prompts; captions describe independent work, the actual mismatch, then the user correction. Revised Friday dialogue is a scripted concise summary of the recorded engine guidance, not a verbatim engine response. clarify-modes.cjs generates these production voice clips.

Brand revision: Friday is the on-screen application name in the actual workspace, opening and closing titles, and closing narration. The Hub was recaptured from the updated renderer. The learner now uses Will - Relaxed Optimist with eleven_v4 through the text-to-dialogue API. Expert remains Chris and Friday remains Jessica; those retained production clips use Multilingual v2. friday-brand-voice.cjs applies the final voice/brand revision after clarify-modes.cjs.
