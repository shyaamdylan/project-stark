const test = require('node:test');
const assert = require('node:assert');
const { otherAudioPids } = require('../src/macaudio');

const sample = `Listed by owning process:
   pid 380(coreaudiod): [0x0001] 00:00:12 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"
	Created for PID: 4242.
	Resources: audio-out builtin-speaker-device
   pid 380(coreaudiod): [0x0002] 00:00:05 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInMicrophoneDevice.context.preventuseridlesleep"
	Created for PID: 777.
	Resources: audio-in builtin-microphone-device
   pid 380(coreaudiod): [0x0003] 00:00:02 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep"
	Created for PID: 777.
	Resources: audio-out builtin-speaker-device
   pid 99(SomeApp): [0x0004] 00:01:00 PreventUserIdleDisplaySleep named: "Video Wake Lock"`;

test("another app playing sound is found; our own playback and the microphone aren't", () => {
  assert.deepEqual(otherAudioPids(sample, [777]), [4242]);
  assert.deepEqual(otherAudioPids(sample, [777, 4242]), []);
  assert.deepEqual(otherAudioPids('', []), []);
});
