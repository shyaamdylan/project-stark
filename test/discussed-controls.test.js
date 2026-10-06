const test=require('node:test');
const assert=require('node:assert/strict');
const {discussedControls}=require('../src/discussed-controls');
const control=(label,x=1100)=>({role:'AXButton',label,x,y:700,w:100,h:40});
test('spoken instructions match a named control without pointing coordinates',()=>{
 assert.deepEqual(discussedControls('You can dismiss the notice, then select Continue.',[control('Dismiss'),control('Continue')]).map(e=>e.label),['Dismiss','Continue']);
});
test('labels can contain status text, and articles in speech do not prevent a match',()=>{
 assert.equal(discussedControls('Skip the ad to continue the video.',[control('Skip Ad · 5 seconds')])[0].label,'Skip Ad · 5 seconds');
});
test('static text and controls not mentioned are not avoidance targets',()=>{
 assert.equal(discussedControls('Open the document.',[control('Delete'),{...control('Document'),role:'AXStaticText'}]).length,0);
});
