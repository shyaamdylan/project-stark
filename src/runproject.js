// Starting a software project for the user ("Jarvis, get PianoScribe running").
//
// Deliberately narrow. Jarvis may only run a command that the project itself
// documents: written in its README, a package.json script, or a Makefile
// target, run inside that project's folder in the home folder. Each one is
// shown to the user word for word and needs a yes (src/jarvis.js), and runs in
// a visible Terminal window they can stop with Ctrl-C. Commands that delete,
// need admin rights, run a script straight from the internet or change the
// system are refused even if a README contains them.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BAD_COMMAND = [
  [/\bsudo\b|\bsu\s|\bdoas\b/, 'it needs admin rights'],
  [/\brm\s|\brmdir\b|\bunlink\b|\bshred\b|\b(make|npm run)\s+[\w-]*(clean|reset|nuke|purge|wipe)/, 'it deletes files'],
  [/\b(curl|wget)\b.*\|\s*(ba|z)?sh\b|\$\(\s*(curl|wget)\b/, 'it runs a script straight from the internet'],
  [/\b(mkfs|diskutil|dd|launchctl|csrutil|spctl|chown|shutdown|reboot|killall)\b|\bdefaults\s+write\b|\bchmod\s+-R\b|>\s*\/(dev|etc|System|usr)\b/, 'it changes the system'],
  [/\bgit\s+(push|reset|clean|checkout)\b/, 'it changes the repository'],
  [/[;&|`]|\$\(/, 'it chains several commands'],
];

// "PORT=3100 ./run.sh --prod" -> { env: ['PORT=3100'], cmd: './run.sh --prod' }
function splitEnv(command) {
  const parts = String(command).trim().split(/\s+/);
  const env = [];
  while (parts.length && /^[A-Z_][A-Z0-9_]*=[\w.:/-]*$/.test(parts[0])) env.push(parts.shift());
  return { env, cmd: parts.join(' ') };
}

// Commands the project documents, from its README(s), package.json and Makefile.
function documentedCommands(dir) {
  const out = new Set();
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return '';
    }
  };
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!/^readme(\.(md|txt|rst))?$/i.test(f)) continue;
    const text = read(f);
    // Lines in code blocks and `inline code`.
    for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/gi)) {
      for (const line of block[1].split('\n')) {
        const l = line.replace(/^\s*\$\s*/, '').replace(/\s+#.*$/, '').trim();
        if (l && !l.startsWith('#')) out.add(splitEnv(l).cmd);
      }
    }
    for (const m of text.matchAll(/`([^`\n]{2,120})`/g)) out.add(splitEnv(m[1].trim()).cmd);
  }
  try {
    const pkg = JSON.parse(read('package.json'));
    const scripts = Object.keys(pkg.scripts || {});
    if (scripts.length || pkg.dependencies || pkg.devDependencies) ['npm install', 'npm ci'].forEach((c) => out.add(c));
    for (const s of scripts) {
      out.add(`npm run ${s}`);
      if (['start', 'test'].includes(s)) out.add(`npm ${s}`);
    }
  } catch {}
  for (const m of read('Makefile').matchAll(/^([a-zA-Z][\w-]*):/gm)) out.add(`make ${m[1]}`);
  out.delete('');
  return out;
}

// The folder to run in: an existing, visible folder inside the home folder.
function projectFolder(folder, home = os.homedir()) {
  const f = String(folder || '').trim();
  if (!f) return null;
  const p = f.startsWith('~') ? path.join(home, f.slice(1)) : path.isAbsolute(f) ? f : path.join(home, f);
  let real;
  try {
    real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) return null;
  } catch {
    return null;
  }
  const rel = path.relative(home, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (rel.split(path.sep).some((x) => x.startsWith('.')) || rel === 'Library' || rel.startsWith(`Library${path.sep}`)) return null;
  return real;
}

// May Jarvis offer to run this? -> { ok: true, dir } or { ok: false, why }.
function commandVerdict(command, folder, { home = os.homedir() } = {}) {
  const c = String(command || '').trim();
  if (!c) return { ok: false, why: 'there was no command' };
  if (c.length > 200 || /\n/.test(c)) return { ok: false, why: "it's too long to check" };
  for (const [re, why] of BAD_COMMAND) if (re.test(c)) return { ok: false, why };
  const dir = projectFolder(folder, home);
  if (!dir) return { ok: false, why: "that folder isn't a project in your home folder" };
  const { cmd } = splitEnv(c);
  if (!documentedCommands(dir).has(cmd)) return { ok: false, why: "the project's README, package.json or Makefile doesn't give that command" };
  return { ok: true, dir };
}

// Web addresses a dev server printed ("Local: http://localhost:3100").
function findUrls(text) {
  const urls = [...String(text).matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s'")\]]*/g)].map((m) => m[0].replace('0.0.0.0', 'localhost').replace(/[.,]$/, ''));
  return [...new Set(urls)];
}

// AppleScript string literal.
const asString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
// Shell single-quoted word.
const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// A .command file Terminal runs when opened (no Automation permission needed):
// it goes to the project, runs the command, and copies the output to `log`.
function commandFile(dir, command, log) {
  return `#!/bin/bash\ncd ${shQuote(dir)} || exit 1\necho ${shQuote(`Jarvis is running: ${command}`)}\n{ ${command} ; } 2>&1 | tee ${shQuote(log)}\n`;
}

module.exports = { commandVerdict, documentedCommands, projectFolder, splitEnv, findUrls, commandFile, shQuote };
