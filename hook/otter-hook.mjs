#!/usr/bin/env node
// Claude Code runs this for each hook event inside an Otterdeck tab (see server/hooks.ts).
// It forwards the event to Otterdeck and always exits 0 quickly, so it can never hold Claude up.

const event = process.argv[2];
const { OTTER_URL: url, OTTER_TOKEN: token, OTTER_TAB: tab } = process.env;
if (!url || !tab || !event) process.exit(0);

let input = '';
let sent = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', send);
setTimeout(send, 1500);

async function send() {
  if (sent) return;
  sent = true;
  let payload = {};
  try {
    payload = JSON.parse(input || '{}');
  } catch {}
  // Tool output can be large and Otterdeck doesn't need it.
  delete payload.tool_response;
  try {
    await fetch(`${url}/api/hook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-otter-token': token ?? '' },
      body: JSON.stringify({ tab, event, payload }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
  process.exit(0);
}
