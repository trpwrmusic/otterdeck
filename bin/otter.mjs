#!/usr/bin/env node
// otter – starts Otterdeck in the background (if it isn't running) and opens its window.
//
//   otter            open Otterdeck
//   otter stop       stop the server (ends all sessions)
//   otter status     is it running?
//   otter restart    restart into the current code once no Claude is working

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.OTTER_PORT || 4747);
const URL = `http://127.0.0.1:${PORT}`;
const DATA = path.join(process.env.APPDATA || '', 'Otterdeck');
const LOG = path.join(DATA, 'server.log');

async function running() {
  try {
    const r = await fetch(`${URL}/api/ping`, { signal: AbortSignal.timeout(800) });
    return (await r.json()).app === 'otterdeck';
  } catch {
    return false;
  }
}

function startServer() {
  fs.mkdirSync(DATA, { recursive: true });
  const out = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server', 'index.ts')], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
}

function findBrowser() {
  const pf = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = ['Microsoft\\Edge\\Application\\msedge.exe', 'Google\\Chrome\\Application\\chrome.exe'];
  for (const base of pf) for (const r of rel) if (fs.existsSync(path.join(base, r))) return path.join(base, r);
  return null;
}

function openWindow() {
  const browser = findBrowser();
  if (browser) {
    spawn(browser, [`--app=${URL}`], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('cmd.exe', ['/c', 'start', '', URL], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
}

const cmd = process.argv[2];

if (cmd === 'status') {
  console.log((await running()) ? `Otterdeck läuft auf ${URL}` : 'Otterdeck läuft nicht.');
} else if (cmd === 'restart') {
  if (!(await running())) console.log('Otterdeck läuft nicht.');
  else {
    await fetch(`${URL}/api/restart`, { method: 'POST', headers: { origin: URL } });
    console.log('Neustart vorgemerkt: Otterdeck startet neu, sobald kein Claude mehr arbeitet.');
  }
} else if (cmd === 'stop') {
  if (!(await running())) {
    console.log('Otterdeck läuft nicht.');
  } else {
    await fetch(`${URL}/api/shutdown`, { method: 'POST', headers: { origin: URL } }).catch(() => {});
    console.log('Otterdeck beendet.');
  }
} else {
  if (!(await running())) {
    startServer();
    for (let i = 0; i < 50 && !(await running()); i++) await new Promise((r) => setTimeout(r, 200));
    if (!(await running())) {
      console.error(`Otterdeck startet nicht. Details: ${LOG}`);
      process.exit(1);
    }
  }
  if (process.env.OTTER_NO_WINDOW !== '1') openWindow();
  else console.log(`Otterdeck läuft auf ${URL}`);
}
