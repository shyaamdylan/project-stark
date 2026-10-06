const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function recordingDir(root, id) {
  if (typeof id !== 'string' || !id || path.basename(id) !== id || id === '.' || id === '..') return null;
  const dir = path.join(root, id);
  return fs.existsSync(dir) && fs.lstatSync(dir).isDirectory() ? dir : null;
}
function listRecordings(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).map(id => {
    const dir = recordingDir(root, id); if (!dir) return null;
    const map = read(path.join(dir,'workmap.json')), session = read(path.join(dir,'session.json'));
    if (!map && !session) return null;
    const steps = map?.steps || [], page = path.join(dir,'index.html');
    return { id, title: map?.title || session?.title || id, summary: map?.summary || '', createdAt: session?.startedAt || fs.statSync(dir).birthtimeMs, steps: steps.length, judgments: steps.filter(s=>s.is_judgment).length, confirmed: Boolean(map?.confirmed), page: map && fs.existsSync(page) ? pathToFileURL(page).href : null };
  }).filter(Boolean).sort((a,b)=>b.createdAt-a.createdAt);
}
function recordingDetails(root,id) {
  const dir = recordingDir(root,id); if (!dir) return null;
  const map = read(path.join(dir,'workmap.json')); if (!map) return null;
  const session = read(path.join(dir,'session.json')) || {events:[],qas:[]};
  return {id,map,startedAt:session.startedAt,events:session.events||[],qas:session.qas||[]};
}
module.exports = { listRecordings, recordingDetails, recordingDir };
