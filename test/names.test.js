const test = require('node:test');
const assert = require('node:assert');
const { correctNames } = require('../src/names');

const names = ['PianoScribe', 'project-stark', 'Visual Studio Code', 'Screenshots', 'Notes'];
const fix = (t) => correctNames(t, names).text;

test('misheard project names are corrected against known ones', () => {
  assert.equal(fix('Get Piano Scrap to run locally'), 'Get PianoScribe to run locally');
  assert.equal(fix('open the README for Piano Scribe'), 'open the README for PianoScribe');
  assert.equal(fix("it'll be documents/Pianist Scribe"), "it'll be documents/PianoScribe");
  assert.equal(fix('run the project stark tests'), 'run the project-stark tests');
});

test('ordinary words and right names are left alone', () => {
  assert.equal(fix('take a screenshot'), 'take a screenshot');
  assert.equal(fix('open my notes'), 'open my notes');
  assert.equal(fix('open the piano'), 'open the piano');
  assert.equal(fix('open PianoScribe'), 'open PianoScribe');
});
