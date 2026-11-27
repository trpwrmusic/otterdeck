#!/usr/bin/env node
// Builds the release package for this computer's system: otterdeck-<os>-<arch>.tar.gz
// (Otterdeck's files, the built UI and node_modules for this platform). Used by the release
// workflow on GitHub, once per system; the installers and the update unpack it as it is.
//
//   npm run build && node bin/pack.mjs [out-dir]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'release'));
const IS_WIN = process.platform === 'win32';
const name = `otterdeck-${IS_WIN ? 'win' : process.platform}-${process.arch}`;
const stage = fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
const run = (cmd, args, cwd = ROOT) => execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: IS_WIN && cmd === 'npm' });

if (!fs.existsSync(path.join(ROOT, 'dist', 'web', 'index.html'))) {
  console.error('Erst die Oberfläche bauen: npm run build');
  process.exit(1);
}

// Files git knows or would add (not ignored ones like node_modules, dist or logs).
const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  .split('\0')
  .filter((f) => f && !f.startsWith('.github/'));
for (const f of files) {
  fs.mkdirSync(path.dirname(path.join(stage, f)), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), path.join(stage, f));
}
fs.cpSync(path.join(ROOT, 'dist', 'web'), path.join(stage, 'dist', 'web'), { recursive: true });

console.log('· Pakete für', name);
if (IS_WIN) {
  // node-pty brings its Windows binaries along.
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], stage);
} else {
  // node-pty has no Linux build without a compiler; the prebuilt fork takes over (see server/tabs.ts).
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], stage);
  run('npm', ['rebuild', '@homebridge/node-pty-prebuilt-multiarch'], stage);
}

fs.mkdirSync(OUT, { recursive: true });
const file = path.join(OUT, name + '.tar.gz');
fs.rmSync(file, { force: true });
// Windows 10 and newer bring bsdtar along; it writes a gzip archive with -z as well.
run(IS_WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-czf', file, '-C', stage, '.']);
fs.rmSync(stage, { recursive: true, force: true });
console.log(`· ${file} (${(fs.statSync(file).size / 1e6).toFixed(1)} MB)`);
