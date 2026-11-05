#!/usr/bin/env node
// Claude Code's status line inside an Otterdeck tab. Claude passes the session state as JSON on
// stdin, including the plan's usage limits (rate_limits). We print a short line for the terminal and
// hand the limits to Otterdeck, which shows them per account. Never slow: printing comes first.

const { OTTER_URL: url, OTTER_TOKEN: token, OTTER_TAB: tab } = process.env;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', run);
setTimeout(run, 1200);

let done = false;
async function run() {
  if (done) return;
  done = true;
  let s = {};
  try {
    s = JSON.parse(input || '{}');
  } catch {}
  const rl = s.rate_limits ?? null;
  const pct = (w) => (w && typeof w.used_percentage === 'number' ? `${Math.round(w.used_percentage)} %` : null);
  const parts = [s.model?.display_name, pct(rl?.five_hour) && `5 Std. ${pct(rl.five_hour)}`, pct(rl?.seven_day) && `Woche ${pct(rl.seven_day)}`];
  process.stdout.write(parts.filter(Boolean).join(' · '));
  if (url && tab && rl) {
    try {
      await fetch(`${url}/api/usage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-otter-token': token ?? '' },
        body: JSON.stringify({ tab, rate_limits: rl }),
        signal: AbortSignal.timeout(1000),
      });
    } catch {}
  }
  process.exit(0);
}
