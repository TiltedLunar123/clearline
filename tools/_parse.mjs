import fs from 'node:fs';

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);

const raw = fs.readFileSync(process.argv[2], 'utf8');
const i = raw.indexOf('<result>');
const s = raw.slice(i + 8).trim();
const start = s.indexOf('{');

let depth = 0;
let end = -1;
let inStr = false;
let esc = false;
for (let k = start; k < s.length; k++) {
  const c = s[k];
  if (esc) { esc = false; continue; }
  if (c === BACKSLASH) { esc = true; continue; }
  if (c === QUOTE) { inStr = !inStr; continue; }
  if (inStr) continue;
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { end = k; break; } }
}

if (end < 0) {
  console.log('JSON truncated in the task output; use the journal instead.');
  process.exit(2);
}

const o = JSON.parse(s.slice(start, end + 1));

console.log('=== NAME PICK ===');
console.log('winner :', o.name.winner);
console.log('title  :', o.name.storeTitle);
console.log('runner :', o.name.runnerUp);

console.log('\n=== VETTING ===');
for (const v of o.vetting || []) console.log(String(v.verdict).padEnd(7), v.name);

console.log('\n=== CONFIRMED DEFECTS:', (o.confirmed || []).length, '===');
for (const f of o.confirmed || []) {
  console.log(`[${f.severity}] ${f.file}:${f.line} (${f.lens})`);
  console.log('    ' + f.summary);
}
console.log('\nrefuted:', o.refutedCount);
