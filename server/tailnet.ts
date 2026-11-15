import http from 'node:http';
import tls from 'node:tls';

// Requests from this machine to other devices in the tailnet. Normally a plain fetch. A tailscaled in
// userspace mode (no root, e.g. mc-panel) cannot route the system's traffic into the tailnet; it then
// offers an HTTP proxy (--outbound-http-proxy-listen), named in OTTER_TAILNET_PROXY (e.g.
// http://127.0.0.1:1055). We tunnel through it with CONNECT; TLS stays end to end.

const PROXY = process.env.OTTER_TAILNET_PROXY ? new URL(process.env.OTTER_TAILNET_PROXY) : null;

export interface TailnetResponse {
  ok: boolean;
  status: number;
  json(): Promise<any>;
}

export function tailnetFetch(url: string, init: { headers?: Record<string, string>; timeout?: number } = {}): Promise<TailnetResponse> {
  const timeout = init.timeout ?? 8000;
  if (!PROXY)
    return fetch(url, { headers: init.headers, signal: AbortSignal.timeout(timeout) }).then((r) => ({ ok: r.ok, status: r.status, json: () => r.json() }));
  const target = new URL(url);
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connect.destroy();
      reject(new Error('Zeitüberschreitung'));
    }, timeout);
    const fail = (err: Error) => {
      clearTimeout(timer);
      reject(err);
    };
    const connect = http.request({ host: PROXY.hostname, port: Number(PROXY.port || 80), method: 'CONNECT', path: `${target.hostname}:${port}` });
    connect.on('error', fail);
    connect.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        return fail(new Error(`Proxy: ${res.statusCode}`));
      }
      // TLS over the tunnel, checked against the real host name (tailscale serve's certificate).
      const secure = tls.connect({ socket, servername: target.hostname });
      const req = http.request(
        { host: target.hostname, port, path: target.pathname + target.search, method: 'GET', headers: { host: target.host, ...init.headers }, createConnection: () => secure },
        (r) => {
          let body = '';
          r.setEncoding('utf8');
          r.on('data', (c) => (body += c));
          r.on('end', () => {
            clearTimeout(timer);
            socket.destroy();
            const status = r.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body) });
          });
          r.on('error', fail);
        },
      );
      req.on('error', fail);
      req.end();
    });
    connect.end();
  });
}
