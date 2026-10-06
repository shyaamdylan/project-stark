const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(file) {
    this.file = file;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schema: 1, users: [], businesses: [], invites: [] };
    if (this.data.schema !== 1) throw new Error('Unsupported workspace data version.');
  }
  commit(change) {
    const next = structuredClone(this.data);
    const result = change(next);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.' + crypto.randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.data = next;
    return result;
  }
}
module.exports = { Store };
