const test = require('node:test');
const assert = require('node:assert');
const { avoid } = require('../src/avoid');

const screen = { x: 0, y: 0, w: 1440, h: 900 };
const island = { w: 320, h: 120 };
const run = (steps, dock = null) => {
  let state = {};
  return steps.map((cursor) => {
    const r = avoid({ island, screen, dock, cursor }, state);
    state = r.state;
    return [r.offset, r.edge];
  });
};

test('the cursor never moves it, even right over it', () => {
  assert.deepEqual(run([{ x: 1300, y: 860 }]), [[{ x: 0, y: 0 }, null]]);
});

test('a Dock showing over the corner lifts it just clear, flush to the right edge; one that does not reach the corner leaves it be', () => {
  const wide = { side: 'bottom', autohide: false, rect: { x: 200, y: 830, w: 1150, h: 70 } };
  const narrow = { side: 'bottom', autohide: false, rect: { x: 500, y: 830, w: 440, h: 70 } };
  assert.deepEqual(run([{ x: 300, y: 300 }], wide), [[{ x: 0, y: -78 }, 'right']]);
  assert.deepEqual(run([{ x: 300, y: 300 }], narrow), [[{ x: 0, y: 0 }, null]]);
});

test('an auto-hiding Dock only moves it while the Dock is out', () => {
  const dock = { side: 'bottom', autohide: true, rect: { x: 200, y: 830, w: 1150, h: 70 } };
  const [hidden, shown, stillShown, gone] = run([{ x: 700, y: 500 }, { x: 700, y: 899 }, { x: 700, y: 850 }, { x: 700, y: 500 }], dock);
  assert.deepEqual(hidden[0], { x: 0, y: 0 });
  assert.deepEqual(shown[0], { x: 0, y: -78 });
  assert.deepEqual(stillShown, shown);
  assert.deepEqual(gone[0], { x: 0, y: 0 });
});

test('a Dock on the right moves it left, flush to the bottom edge', () => {
  const dock = { side: 'right', autohide: false, rect: { x: 1370, y: 150, w: 70, h: 760 } };
  assert.deepEqual(run([{ x: 300, y: 300 }], dock), [[{ x: -78, y: 0 }, 'bottom']]);
});

const overlaps = (a,b) => a.x < b.x+b.w && b.x < a.x+a.w && a.y < b.y+b.h && b.y < a.y+a.h;
function assertClear(r,target,display=screen,box=island,home=null){
  const origin=home||{x:display.x+display.w-box.w,y:display.y+display.h-box.h};
  const placed={x:origin.x+r.offset.x,y:origin.y+r.offset.y,w:box.w,h:box.h};
  assert.equal(overlaps(placed,{x:target.x-24,y:target.y-24,w:target.w+48,h:target.h+48}),false);
  assert.ok(placed.x>=display.x&&placed.y>=display.y&&placed.x+placed.w<=display.x+display.w&&placed.y+placed.h<=display.y+display.h);
  return placed;
}
test('a bottom-right control moves the whole assistant along an edge so it remains clickable',()=>{
  const target={x:1250,y:805,w:150,h:45};
  const r=avoid({island,screen,target,cursor:{x:1300,y:830}});
  assertClear(r,target);assert.notDeepEqual(r.offset,{x:0,y:0});
});
test('a target elsewhere leaves the assistant at home',()=>{
  const r=avoid({island,screen,target:{x:400,y:200,w:150,h:40},cursor:{x:0,y:0}});
  assert.deepEqual(r.offset,{x:0,y:0});
});
test('a showing Dock and the pointed control are both avoided',()=>{
  const dock={side:'bottom',autohide:false,rect:{x:200,y:830,w:1150,h:70}};
  const target={x:1200,y:715,w:170,h:40};const r=avoid({island,screen,target,dock,cursor:{x:0,y:0}});
  const placed=assertClear(r,target);assert.equal(overlaps(placed,dock.rect),false);
});
test('growth of a speech card recomputes clearance and moved targets do not cause edge oscillation',()=>{
  const target={x:1250,y:810,w:140,h:40};const first=avoid({island,screen,target,cursor:{x:0,y:0}});
  const larger={w:400,h:280};const next=avoid({island:larger,screen,target,cursor:{x:0,y:0}},first.state);
  assertClear(next,target,screen,larger);
  const moved={...target,y:target.y+5};const again=avoid({island:larger,screen,target:moved,cursor:{x:0,y:0}},next.state);
  assertClear(again,moved,screen,larger);assert.deepEqual(again.offset,next.offset);
});
test('floating/notch bounds and monitors with negative origins use the same target clearance',()=>{
  const display={x:-1440,y:-200,w:1440,h:900},box={w:350,h:230};
  const home={x:-900,y:-200,w:350,h:230},target={x:-850,y:-150,w:130,h:45};
  const r=avoid({island:box,screen:display,home,target,cursor:{x:-800,y:-100}});
  assertClear(r,target,display,box,home);
});
test('during instructions the assistant yields to an approaching cursor without a known target',()=>{
 const r=avoid({island:{...island,yieldToCursor:true},screen,cursor:{x:1300,y:820},nowMs:1000});
 assert.notDeepEqual(r.offset,{x:0,y:0});assertClear(r,{x:1288,y:808,w:24,h:24});
});
test('the assistant does not dodge its own controls or a question input',()=>{
 const control={x:1270,y:800,w:100,h:40};
 const r=avoid({island:{...island,yieldToCursor:true,controls:[control]},screen,cursor:{x:1300,y:820},nowMs:1000});
 assert.deepEqual(r.offset,{x:0,y:0});
});
