import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Use npm's package whitelist for both formats; zip uses stored entries (no dependencies).
const root = resolve(import.meta.dirname, '..');
process.chdir(root);
const out = resolve('dist');
mkdirSync(out, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'dsh-bot-pack-'));
try {
  const args = ['pack', '--json', '--ignore-scripts', '--pack-destination', 'dist'];
  const packed = process.env.npm_execpath
    ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], { encoding: 'utf8' })
    : spawnSync('npm pack --json --ignore-scripts --pack-destination dist', { encoding: 'utf8', shell: true });
  if (packed.status !== 0) throw new Error(packed.stderr || 'npm pack failed');
  const filename = JSON.parse(packed.stdout)[0].filename;
  rmSync(join(out, 'dsh-bot.tgz'), { force: true });
  renameSync(join(out, filename), join(out, 'dsh-bot.tgz'));
  execFileSync('tar', ['-xzf', join(out, 'dsh-bot.tgz'), '-C', work]);
  const chunks = [], central = [];
  let offset = 0, count = 0;
  function walk(dir, prefix) {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name), name = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) { walk(file, name); continue; }
      const data = readFileSync(file), encoded = Buffer.from(name);
      let crc = 0xffffffff;
      for (const byte of data) { crc ^= byte; for (let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
      crc = (crc ^ 0xffffffff) >>> 0;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(0x800,6);
      header.writeUInt16LE(33,12); // 1980-01-01, deterministic timestamp
      header.writeUInt32LE(crc,14); header.writeUInt32LE(data.length,18); header.writeUInt32LE(data.length,22); header.writeUInt16LE(encoded.length,26);
      const index = Buffer.alloc(46);
      index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20,4); header.copy(index,6,4,30); index.writeUInt32LE(offset,42);
      chunks.push(header,encoded,data); central.push(index,encoded);
      offset += header.length + encoded.length + data.length; count++;
    }
  }
  walk(join(work,'package'), 'dsh-bot');
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count,8); end.writeUInt16LE(count,10); end.writeUInt32LE(directory.length,12); end.writeUInt32LE(offset,16);
  writeFileSync(join(out,'dsh-bot.zip'),Buffer.concat([...chunks,directory,end]));
  writeFileSync(join(out,'SHA256SUMS'), ['dsh-bot.tgz','dsh-bot.zip'].map(name => `${createHash('sha256').update(readFileSync(join(out,name))).digest('hex')}  ${name}\n`).join(''));
  console.log('Built dist/dsh-bot.tgz, dist/dsh-bot.zip, dist/SHA256SUMS');
} finally { rmSync(work, { recursive: true, force: true }); }
