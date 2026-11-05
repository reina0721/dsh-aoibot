import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const win = process.platform === 'win32';
const gitShell = 'C:/Program Files/Git/bin/sh.exe';
const targets = win ? ['PowerShell', ...(existsSync(gitShell) ? ['Shell'] : [])] : ['Shell'];
const cases = ['fixed', 'latest', 'missing-dsh', 'download-failed', 'checksum-failed', 'install-failed', 'missing-profile', 'invalid-version'];
for (const target of targets) for (const scenario of cases) test(`installer ${target}: ${scenario}`, { timeout: 30000 }, () => {
  const ps = target === 'PowerShell';
  const root = mkdtempSync(join(tmpdir(), 'dsh-bot installer '));
  const bin=join(root,'mock bin'), scratch=join(root,'downloads'), home=join(root,'dsh home');
  mkdirSync(bin); mkdirSync(scratch);
  const archive=Buffer.from('offline release fixture');
  const digest=createHash('sha256').update(archive).digest('hex');
  const fixture=join(root,'fixture.tgz'), sums=join(root,'SHA256SUMS'), log=join(root,'invocations.txt');
  writeFileSync(fixture,archive);
  writeFileSync(sums,`${scenario === 'checksum-failed' ? '0'.repeat(64) : digest}  dsh-bot.tgz\n`);
  const dsh=join(bin,ps?'fake dsh.cmd':'fake dsh');
  writeFileSync(dsh,ps ? '@echo off\r\necho %*>>"%INSTALL_LOG%"\r\nexit /b %INSTALL_EXIT%\r\n' : '#!/bin/sh\nprintf "%s\\n" "$@" > "$INSTALL_LOG"\nexit "$INSTALL_EXIT"\n',{mode:0o755});
  const env={...process.env,DSH_HOME:home,TEMP:scratch,TMP:scratch,TMPDIR:scratch,INSTALL_FIXTURE:fixture,INSTALL_SUMS:sums,INSTALL_LOG:log,INSTALL_EXIT:scenario==='install-failed'?'7':'0',INSTALL_SCENARIO:scenario};
  const args=[];
  if(scenario !== 'missing-profile')args.push(ps?'-Profile':'--profile','test-profile');
  args.push(ps?'-DshPath':'--dsh',scenario==='missing-dsh'?join(root,'absent-dsh'):dsh);
  args.push(ps?'-Version':'--version',scenario==='latest'?'latest':scenario==='invalid-version'?'../bad':'0.10.0');
  let result;
  try {
    if(ps) {
      const harness=join(root,'harness.ps1');
      writeFileSync(harness,`$ErrorActionPreference = 'Stop'
function Invoke-RestMethod { param($Uri) [IO.File]::AppendAllText($env:INSTALL_LOG + '.urls', [string]$Uri + [Environment]::NewLine); return @{tag_name='v0.10.0'} }
function Invoke-WebRequest { param([switch]$UseBasicParsing, $Uri, $OutFile)
  [IO.File]::AppendAllText($env:INSTALL_LOG + '.urls', [string]$Uri + [Environment]::NewLine)
  if($env:INSTALL_SCENARIO -eq 'download-failed') { throw 'offline download failure' }
  $source = if($Uri.EndsWith('/SHA256SUMS')) { $env:INSTALL_SUMS } else { $env:INSTALL_FIXTURE }
  [IO.File]::Copy($source,$OutFile)
}
& '${resolve('scripts/install.ps1').replaceAll("'","''")}' @args
exit $LASTEXITCODE
`);
      result=spawnSync('powershell',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',harness,...args],{env,encoding:'utf8'});
    } else {
      writeFileSync(join(bin,'curl'),`#!/bin/sh
printf '%s\\n' "$*" >> "$INSTALL_LOG.urls"
[ "$INSTALL_SCENARIO" != download-failed ] || exit 22
case "$2" in
  */releases/latest) printf '%s\\n' '{"tag_name":"v0.10.0"}';;
  */SHA256SUMS) cp "$INSTALL_SUMS" "$4";;
  */dsh-bot.tgz) cp "$INSTALL_FIXTURE" "$4";;
  *) exit 22;;
esac
`,{mode:0o755});
      env.PATH=bin+delimiter+process.env.PATH;
      if(win) for(const key of ['DSH_HOME','TEMP','TMP','TMPDIR','INSTALL_FIXTURE','INSTALL_SUMS','INSTALL_LOG'])env[key]=env[key].replaceAll('\\','/');
      env.INSTALL_BIN=bin.replaceAll('\\','/');
      const shellArgs=[resolve('scripts/install.sh'),...args].map(s=>win?s.replaceAll('\\','/'):s);
      result=spawnSync(win?gitShell:'sh',win?['-c','export PATH="$(cygpath -u "$INSTALL_BIN"):$PATH"; exec sh "$@"','fixture',...shellArgs]:shellArgs,{env,encoding:'utf8'});
    }
    const success=['fixed','latest'].includes(scenario);
    assert.equal(result.status===0,success,result.stdout+'\n'+result.stderr);
    assert.equal(existsSync(log),success||scenario==='install-failed');
    if(success) {
      const text=readFileSync(log,'utf8');
      assert.match(text,/plugin/); assert.match(text,/test-profile/);
      const cached=join(home,'plugins-cache','dsh-bot','v0.10.0','dsh-bot.tgz');
      assert.deepEqual(readFileSync(cached),archive);
      assert.ok(text.replaceAll('\\','/').includes(cached.replaceAll('\\','/')));
      const urls=readFileSync(log+'.urls','utf8');
      assert.ok(urls.includes('/releases/download/v0.10.0/dsh-bot.tgz'));
      assert.ok(urls.includes('/releases/download/v0.10.0/SHA256SUMS'));
    }
    assert.deepEqual(readdirSync(scratch),[],'temporary downloads must be cleaned after success or failure');
  } finally { rmSync(root,{recursive:true,force:true}); }
});
