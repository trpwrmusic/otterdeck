// "Chat mit anderem Anbieter fortsetzen": when one subscription hits its limit (or you just want a
// different model), the conversation goes on in a new tab with another provider. The old chat is
// written as readable Markdown into the upload folder, which every Claude and agy tab may read
// (--add-dir), and the new session starts with its path and the instruction to pick up from there.

import fs from 'node:fs';
import path from 'node:path';
import type { ChatItem } from '../shared/types.ts';
import { UPLOAD_DIR } from './config.ts';
import { AgyTranscriptTail } from './agy.ts';
import { TranscriptTail } from './transcript.ts';
import type { Tab } from './tabs.ts';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ' …' : s);

function itemMarkdown(it: ChatItem, agent: string): string | null {
  switch (it.k) {
    case 'user':
      return `### Ich\n\n${it.text.trim()}`;
    case 'text':
      return `### ${agent}\n\n${it.text.trim()}`;
    case 'tool': {
      const res = it.result ? clip(it.result.text.replace(/\s+$/, ''), 600) : '';
      return `- **${it.summary || it.name}**${it.result?.error ? ' (Fehler)' : ''}${res ? `\n\n  \`\`\`\n  ${res.split('\n').join('\n  ')}\n  \`\`\`` : ''}`;
    }
    case 'shell':
      return `- **Befehl** \`${it.cmd}\`${it.out || it.err ? `\n\n  \`\`\`\n  ${clip([it.out, it.err].filter(Boolean).join('\n'), 600).split('\n').join('\n  ')}\n  \`\`\`` : ''}`;
    case 'note':
      return `_${it.text}_`;
    default:
      return null; // thinking stays out: long and not needed to carry on
  }
}

/** Writes the tab's conversation as Markdown and returns the file path. */
export function exportChat(tab: Tab, projectName: string): string {
  const file = tab.transcriptFile();
  if (!file || !fs.existsSync(file)) throw new Error('Zu diesem Tab gibt es noch keinen Chatverlauf.');
  const tail = tab.rec.kind === 'agy' ? new AgyTranscriptTail(file) : new TranscriptTail(file);
  const items = tail.load();
  if (!items.length) throw new Error('Der Chatverlauf ist leer.');
  const agent = tab.rec.kind === 'agy' ? 'Antigravity' : 'Claude';
  const when = new Date().toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
  const body = items
    .map((it) => itemMarkdown(it, agent))
    .filter(Boolean)
    .join('\n\n');
  const md = [
    `# Bisheriger Chat: ${tab.view().title}`,
    '',
    `Projekt: ${projectName} · bisher mit ${agent}${tab.view().model ? ` (${tab.view().model})` : ''} · exportiert ${when}`,
    tail.truncated ? '\n_Sehr langer Chat: nur der letzte Teil ist enthalten._' : '',
    `Originaler Verlauf: ${file}`,
    '',
    '---',
    '',
    body,
    '',
  ].join('\n');
  const dir = path.join(UPLOAD_DIR, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const safe = (projectName || 'chat').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'chat';
  const out = path.join(dir, `${new Date().toLocaleDateString('sv')}-${safe}-${tab.rec.id}.md`);
  fs.writeFileSync(out, md, 'utf8');
  return out;
}

/** The first message of the new tab. */
export function continuePrompt(file: string, from: string) {
  return [
    `Wir setzen einen Chat fort, der bisher mit ${from} lief (dort ist das Nutzungslimit erreicht, oder ich wechsle bewusst den Anbieter).`,
    `Der ganze bisherige Verlauf steht in dieser Datei: ${file}`,
    'Lies sie vollständig durch und übernimm den Stand: was schon erledigt ist, was noch offen ist und woran zuletzt gearbeitet wurde.',
    'Führe den Chat ab jetzt genau an dieser Stelle fort. Fasse mir zuerst in zwei, drei Sätzen zusammen, wo wir stehen und was du als Nächstes tust.',
  ].join('\n');
}
