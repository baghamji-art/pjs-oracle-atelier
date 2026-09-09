'use strict';
// Read-only release check. Reports file/line/type only, never matched credentials.
const fs = require('node:fs');
const path = require('node:path');

function findings(text) {
  const results = [];
  const add = (kind, index) => results.push({ kind, line: text.slice(0,index).split('\n').length });
  for (const [kind, pattern] of [
    ['OpenAI secret literal', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/g],
    ['Supabase secret literal', /\bsb_secret_[A-Za-z0-9_-]{16,}/g]
  ]) {
    for (const match of text.matchAll(pattern)) add(kind, match.index);
  }
  for (const match of text.matchAll(/\beyJ[A-Za-z0-9_-]+\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
    try {
      if (JSON.parse(Buffer.from(match[1], 'base64url')).role === 'service_role') {
        add('Supabase service-role JWT literal', match.index);
      }
    } catch (_) {}
  }
  return results;
}

function scan(root) {
  const results = [];
  function visit(entry) {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return; // Never read outside the scoped release directories.
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(entry)) if (name !== 'node_modules') visit(path.join(entry,name));
    } else if (/\.(?:html|[cm]?js|json|css|sql|txt)$/.test(entry)) {
      for (const issue of findings(fs.readFileSync(entry,'utf8'))) {
        results.push({ file:path.relative(root,entry), ...issue });
      }
    }
  }
  for (const directory of ['outputs','netlify']) visit(path.join(root,directory));
  return results;
}

if (require.main === module) {
  const issues = scan(path.resolve(__dirname,'..'));
  console.log(JSON.stringify({ check:'release-secret-literals', ok:issues.length===0, findings:issues },null,2));
  if (issues.length) process.exitCode = 1;
}
module.exports = { findings, scan };
