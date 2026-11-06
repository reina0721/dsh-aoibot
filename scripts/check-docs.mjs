import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
const root = resolve(import.meta.dirname, '..'), errors = [];
function walk(dir) {
  for(const entry of readdirSync(dir,{withFileTypes:true})) {
    if(['.git','.ctx','.agents','.codex','node_modules','dist','verify-out','tmp'].includes(entry.name))continue;
    if(relative(root,dir).replaceAll('\\','/') === 'docs/archive' && entry.name !== 'README.md')continue;
    const file=resolve(dir,entry.name), rel=relative(root,file).replaceAll('\\','/');
    if(entry.isDirectory()) { walk(file); continue; }
    if(!/\.(md|js|mjs|json|yml|ps1|sh)$/.test(entry.name))continue;
    const text=readFileSync(file,'utf8');
    // Migration and compatibility tests deliberately mention obsolete names.
    if(!['docs/MIGRATION.md','test/naming.test.js','scripts/check-docs.mjs'].includes(rel) && /dsh-onebot-qq|DSH_ONEBOT_QQ_DATA_DIR|dsh-aoibot|packages[/\\]dsh-bot/.test(text)) errors.push(`${rel}: obsolete product name or path`);
    if(!file.endsWith('.md'))continue;
    for(const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
      const url=match[1].replace(/^<|>$/g,'').split(/\s+"/)[0];
      if(/^(https?:|mailto:|#)/.test(url))continue;
      const target=decodeURIComponent(url.split('#')[0]);
      if(target && !existsSync(resolve(dirname(file),target)))errors.push(`${rel}: missing link ${url}`);
    }
  }
}
walk(root);
if(errors.length){console.error(errors.join('\n'));process.exitCode=1}
else console.log('Local document links and current naming verified (historical archive excluded).');
