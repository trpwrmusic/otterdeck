import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type http from 'node:http';
import { PORT } from './config.ts';
import type { RemoteView } from '../shared/types.ts';

// Phone access over Tailscale. Otterdeck itself keeps listening on 127.0.0.1 only; `tailscale serve`
// publishes it inside the tailnet as https://<this machine>.<tailnet>.ts.net and adds the caller's
// identity (Tailscale-User-Login). Requests coming that way are accepted only from the owner of this
// machine; nothing is reachable from the internet (that would be Funnel, which we never turn on).

const TAILSCALE =
  process.env.OTTER_TAILSCALE ||
  (process.platform === 'win32'
    ? ['C:\\Program Files\\Tailscale\\tailscale.exe', 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe'].find((f) => fs.existsSync(f))
    : ['/usr/bin/tailscale', '/usr/local/bin/tailscale'].find((f) => fs.existsSync(f)));
/** A tailscaled running without root has its own socket (e.g. on mc-panel). */
const SOCKET = process.env.OTTER_TAILSCALE_SOCKET ? ['--socket', process.env.OTTER_TAILSCALE_SOCKET] : [];
/** HTTPS port inside the tailnet: 443 on the PC; on a server where 443 is taken (Funnel) e.g. 4747. */
const SERVE_PORT = Number(process.env.OTTER_SERVE_PORT || 443);

interface Info {
  installed: boolean;
  running: boolean;
  /** e.g. samuel.tailabc123.ts.net */
  host: string | null;
  /** Login of this machine's owner; only they may use the remote page. */
  owner: string | null;
  /** Tailnet IP → device name. */
  peers: Map<string, string>;
  serving: boolean;
  error: string | null;
}

let info: Info = { installed: !!TAILSCALE, running: false, host: null, owner: null, peers: new Map(), serving: false, error: null };

function run(args: string[], timeout = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!TAILSCALE) return reject(new Error('Tailscale ist nicht installiert.'));
    execFile(TAILSCALE, [...SOCKET, ...args], { timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout || err.message).trim()));
      else resolve(stdout);
    });
  });
}

const target = 'http://127.0.0.1:' + PORT;

export async function refreshRemote(): Promise<Info> {
  if (!TAILSCALE) return info;
  try {
    const st = JSON.parse(await run(['status', '--json']));
    const self = st.Self ?? {};
    const peers = new Map<string, string>();
    for (const p of Object.values<any>(st.Peer ?? {})) for (const ip of p.TailscaleIPs ?? []) peers.set(ip, p.HostName ?? p.DNSName ?? ip);
    for (const ip of self.TailscaleIPs ?? []) peers.set(ip, self.HostName ?? 'Dieser PC');
    let serving = false;
    try {
      const sv = await run(['serve', 'status', '--json']);
      serving = sv.includes('127.0.0.1:' + PORT) || sv.includes('localhost:' + PORT);
    } catch {}
    info = {
      installed: true,
      running: st.BackendState === 'Running',
      host: String(self.DNSName ?? '').replace(/\.$/, '') || null,
      owner: st.User?.[String(self.UserID)]?.LoginName ?? null,
      peers,
      serving,
      error: null,
    };
  } catch (err) {
    info = { ...info, running: false, error: (err as Error).message };
  }
  return info;
}
refreshRemote();
setInterval(refreshRemote, 30_000).unref();

export async function setRemote(on: boolean) {
  await refreshRemote();
  if (!info.running) throw new Error('Tailscale läuft nicht. Starte Tailscale und melde dich an.');
  // --bg keeps the setting after Otterdeck or the PC restarts; "off" removes exactly this entry.
  // Never Funnel: that would put Otterdeck on the internet.
  if (on) await run(['serve', '--bg', '--https=' + SERVE_PORT, target], 20_000);
  else await run(['serve', '--https=' + SERVE_PORT, 'off'], 20_000);
  return refreshRemote();
}

// ---------- requests that came through tailscale serve ----------

const hostOnly = (h: string | undefined) => {
  const s = String(h ?? '').toLowerCase();
  return s.endsWith(':' + SERVE_PORT) ? s.slice(0, -(':' + SERVE_PORT).length) : s;
};
/** Our address in the tailnet, e.g. https://mc-panel.tail….ts.net:4747 */
export const publicUrl = () => (info.host ? 'https://' + info.host + (SERVE_PORT === 443 ? '' : ':' + SERVE_PORT) : null);

/** The request came in through the tailnet address (not the local window). */
export function isRemote(req: http.IncomingMessage) {
  return !!info.host && hostOnly(req.headers.host) === info.host.toLowerCase();
}

/** A tailnet request from the machine's owner, with our own page as origin (if any). */
export function remoteAllowed(req: http.IncomingMessage, needOrigin: boolean) {
  const ok = checkRemote(req, needOrigin);
  // Serve was just switched on (e.g. by the install script): look again right away.
  if (!ok && isRemote(req) && !info.serving) refreshRemote();
  if (!ok && process.env.OTTER_DEBUG_REMOTE)
    console.log('remote abgelehnt', {
      host: req.headers.host,
      addr: req.socket.remoteAddress,
      login: req.headers['tailscale-user-login'],
      origin: req.headers.origin,
      serving: info.serving,
      owner: info.owner,
      me: info.host,
    });
  return ok;
}

function checkRemote(req: http.IncomingMessage, needOrigin: boolean) {
  if (!isRemote(req) || !info.serving || !info.owner) return false;
  // tailscale serve only proxies from the local machine, and sets this header itself.
  const addr = req.socket.remoteAddress ?? '';
  if (addr !== '127.0.0.1' && addr !== '::1' && addr !== '::ffff:127.0.0.1') return false;
  if (String(req.headers['tailscale-user-login'] ?? '').toLowerCase() !== info.owner.toLowerCase()) return false;
  const origin = req.headers.origin;
  if (origin) return origin === publicUrl();
  return !needOrigin;
}

// ---------- connected devices ----------

interface Device {
  name: string;
  since: number;
  count: number;
}
const devices = new Map<string, Device>();

export function deviceName(req: http.IncomingMessage) {
  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return info.peers.get(ip) ?? (ip || 'Gerät');
}

/** Tracks an open remote event connection; returns the function to call when it closes. */
export function trackDevice(req: http.IncomingMessage, changed: () => void) {
  const name = deviceName(req);
  const d = devices.get(name) ?? { name, since: Date.now(), count: 0 };
  d.count++;
  devices.set(name, d);
  changed();
  return () => {
    d.count--;
    if (d.count <= 0) devices.delete(name);
    changed();
  };
}

export function remoteView(): RemoteView {
  return {
    installed: info.installed,
    running: info.running,
    enabled: info.serving,
    url: publicUrl(),
    owner: info.owner,
    error: info.error,
    devices: [...devices.values()].map((d) => ({ name: d.name, since: d.since })),
  };
}
