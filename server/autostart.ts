// "Mit Windows starten": a shortcut in the Startup folder that starts the server without a window.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { IS_WIN, ROOT } from './config.ts';
import { BASE } from './release.ts';

const startup = () => path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Otterdeck.lnk');

/** The script that starts Otterdeck without a console: the installer's, or the one in a checkout. */
const launcher = () => (BASE ? path.join(BASE, 'otterdeck.vbs') : path.join(ROOT, 'bin', 'otter.vbs'));

export const autostartOn = () => IS_WIN && fs.existsSync(startup());

export function setAutostart(on: boolean): Promise<void> {
  if (!IS_WIN) return Promise.resolve();
  const lnk = startup();
  if (!on) {
    fs.rmSync(lnk, { force: true });
    return Promise.resolve();
  }
  const q = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  const ps = [
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + q(lnk) + ')',
    '$s.TargetPath = ' + q(path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'wscript.exe')),
    '$s.Arguments = ' + q('"' + launcher() + '" background'),
    '$s.WorkingDirectory = ' + q(path.dirname(launcher())),
    '$s.Description = ' + q('Otterdeck im Hintergrund starten'),
    '$s.Save()',
  ].join('; ');
  return new Promise((resolve, reject) =>
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20_000 }, (err, _o, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(),
    ),
  );
}
