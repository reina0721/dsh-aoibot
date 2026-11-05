import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDir } from '../src/core/store.js';
import { PLUGIN_ID } from '../src/host.js';

test('new data directory ignores legacy data and legacy override', () => {
  const keys=['DSH_HOME','DSH_BOT_DATA_DIR','DSH_ONEBOT_QQ_DATA_DIR'];
  const before=keys.map(k=>process.env[k]);
  const dir=mkdtempSync(join(tmpdir(),'dsh-bot-naming-'));
  try {
    process.env.DSH_HOME=dir; delete process.env.DSH_BOT_DATA_DIR;
    process.env.DSH_ONEBOT_QQ_DATA_DIR=join(dir,'legacy-override');
    const legacy=join(dir,'plugins-data','dsh-onebot-qq'); mkdirSync(legacy,{recursive:true});
    writeFileSync(join(legacy,'config.json'),'{"legacy":true}');
    assert.equal(dataDir(),join(dir,'plugins-data','dsh-bot'));
    assert.equal(existsSync(dataDir('config.json')),false);
    assert.equal(existsSync(join(legacy,'config.json')),true);
    process.env.DSH_BOT_DATA_DIR=join(dir,'custom data');
    assert.equal(dataDir('config.json'),join(dir,'custom data','config.json'));
    assert.equal(PLUGIN_ID,'dsh-bot');
  } finally {
    keys.forEach((k,i)=>before[i]===undefined?delete process.env[k]:process.env[k]=before[i]);
    rmSync(dir,{recursive:true,force:true});
  }
});
