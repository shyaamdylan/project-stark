// Reversible window organisation. Relevance is suggested; closing is explicit.
const fs = require('fs');
const path = require('path');
const protectedWindow = w => w.dialog || w.edited || w.fullscreen || /terminal|iterm|warp|zoom|teams|facetime|webex/i.test(w.app) || /\b(meeting|call in progress|screen shar(e|ing)|uploading|downloading)\b/i.test(w.title);
const key = w => `${w.pid}:${w.index}:${w.title}`;
const closeEligible = w => !protectedWindow(w) && /^(Finder|Safari|Google Chrome|Brave Browser|Microsoft Edge|Arc|Firefox)$/.test(w.app);
function makePlan(windows, keepIds, area) {
  const kept = new Set(keepIds); const visible = windows.filter(w => kept.has(key(w)) && !w.minimized && !protectedWindow(w) && w.rect);
  const actions = []; const columns = visible.length > 1 ? 2 : 1, rows = Math.ceil(visible.length / columns);
  visible.forEach((w,i) => actions.push({kind:'arrange',window:w,rect:{x:Math.round(area.x + (i % columns)*area.width/columns + 8),y:Math.round(area.y + Math.floor(i/columns)*area.height/rows + 8),w:Math.round(area.width/columns-16),h:Math.round(area.height/rows-16)}}));
  windows.filter(w => !kept.has(key(w)) && !w.frontmost && !w.minimized && !protectedWindow(w)).forEach(w => actions.push({kind:'minimize',window:w}));
  return {actions,closable:windows.filter(w => !kept.has(key(w)) && !w.frontmost && closeEligible(w)),kept:windows.filter(w=>kept.has(key(w))||w.frontmost||protectedWindow(w))};
}
class Organizer {
  constructor({file,inventory,change,choose,ask,area,dry=false}) {Object.assign(this,{file,inventory,change,choose,ask,area,dry});this.busy=false;}
  read(){try{return JSON.parse(fs.readFileSync(this.file,'utf8'))}catch{return null}}
  save(snapshot){if(this.dry)return;fs.mkdirSync(path.dirname(this.file),{recursive:true});const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(snapshot,null,2),{mode:0o600});fs.renameSync(tmp,this.file);}
  async run(request,{cleanup=false}={}) {
    if(this.busy)throw new Error('Workspace organisation is already running.');this.busy=true;
    try {
      const windows=await this.inventory();if(!windows.length)return 'No app windows were found.';
      const chosen=await this.choose(request,windows);const known=new Set(windows.map(key));const keepIds=(chosen||[]).filter(id=>known.has(id));
      windows.filter(w=>w.frontmost).forEach(w=>keepIds.push(key(w)));
      if(!keepIds.length)throw new Error('Tell me which app or task to keep, for example: organise my workspace for the report.');
      const plan=makePlan(windows,keepIds,this.area());
      let closes=[];
      if(cleanup&&plan.closable.length){const answer=await this.ask(`Keep ${plan.kept.map(w=>w.app).filter((a,i,s)=>s.indexOf(a)===i).join(', ')}. Minimise the distractions. Also close these ${plan.closable.length} windows: ${plan.closable.map((w,i)=>`${i+1}. ${w.title||'Untitled'} in ${w.app}`).join('; ')}? Closing browser windows closes their tabs and may lose unsaved website work. Say yes to close all, numbers to close only those, or no to just minimise.`);if(/^\s*(yes|yeah|yep|sure|okay|ok)\b/i.test(answer))closes=plan.closable;else if(/^\s*(?:close\s+)?\d+(?:[\s,]+(?:and\s+)?\d+)*\s*$/i.test(answer))closes=[...new Set(answer.match(/\d+/g).map(Number))].map(i=>plan.closable[i-1]).filter(Boolean);}
      const snapshot={at:Date.now(),changed:[],closed:[],failures:[]};let arranged=0,minimized=0;
      // Journal before each mutation so a crash still leaves a recoverable layout.
      for(const action of plan.actions){if(closes.some(w=>key(w)===key(action.window)))continue;snapshot.changed.push(action.window);this.save(snapshot);try{await this.change(action);if(action.kind==='arrange')arranged++;else minimized++;}catch(e){snapshot.changed.pop();snapshot.failures.push(e.message);this.save(snapshot);}}
      for(const w of closes){try{const r=await this.change({kind:'close',window:w});snapshot.closed.push(w);this.save(snapshot);if(r?.dialog){snapshot.failures.push('An app needs your response to a dialog; remaining closures stopped.');break}}catch(e){snapshot.failures.push(e.message);break}}
      this.save(snapshot);
      return `${this.dry?'Dry run: ':''}Arranged ${arranged} windows, minimised ${minimized}${snapshot.closed.length?`, closed ${snapshot.closed.length}`:''}. ${snapshot.changed.length?'Say “undo workspace organisation” to restore the moved and minimised windows.':''}${snapshot.closed.length?' Closed windows are not restored by Undo.':''}${snapshot.failures.length?` ${snapshot.failures.length} actions could not be completed; those windows were left alone.`:''}`;
    } finally {this.busy=false;}
  }
  async undo(){if(this.busy)throw new Error('Wait for workspace organisation to finish.');this.busy=true;try{const snapshot=this.read();if(!snapshot?.changed?.length)return 'There is no saved window layout to restore.';let restored=0;const remaining=[];for(const w of snapshot.changed.slice().reverse()){try{await this.change({kind:'restore',window:w,rect:w.rect,minimized:w.minimized});restored++}catch{remaining.push(w)}}snapshot.changed=remaining;this.save(snapshot);return `Restored ${restored} windows.${remaining.length?` ${remaining.length} windows are no longer available or could not be restored.`:''}${snapshot.closed?.length?' Previously closed windows cannot be restored.':''}`;}finally{this.busy=false;}}
}
module.exports={Organizer,makePlan,key,protectedWindow,closeEligible};
