// Match controls referred to in speech without requiring a pointing animation.
const STOP = new Set(['a','an','the','to','of','in','on','for','your','this','that','button','link','tab','menu','please','it']);
function words(value) {
  return String(value || '').replace(/([a-z])([A-Z])/g,'$1 $2').toLowerCase().match(/[\p{L}]+/gu)?.filter(w=>!STOP.has(w)) || [];
}
function discussedControls(speech, elements = []) {
  const spoken = new Set(words(speech));
  return elements.map(e=>({...e,rect:e.rect||{x:e.x,y:e.y,w:e.w,h:e.h}})).filter(e=>/^AX(Button|Link|MenuItem|MenuButton|PopUpButton|Tab|CheckBox|RadioButton|ComboBox|TextField|SearchField)$/.test(e.role) && e.rect?.w>0 && e.rect?.h>0).map(e=>{
    const label=words(e.label), matched=label.filter(w=>spoken.has(w));
    const coverage=label.length ? matched.length/label.length : 0;
    return {element:e,coverage,matched:matched.length};
  }).filter(c=>c.coverage===1 || (c.matched>=2 && c.coverage>=.6)).sort((a,b)=>b.coverage-a.coverage||b.matched-a.matched).map(c=>c.element);
}
module.exports = { discussedControls };
