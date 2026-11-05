import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, HOOK_SCRIPT, NODE_BIN, slash } from './config.ts';

/** Hook events Otterdeck listens to. Passed to Claude with --settings, so your own settings stay untouched. */
const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Notification',
  'Stop',
  'SessionEnd',
];

export const HOOK_SETTINGS = path.join(DATA_DIR, 'claude-hooks.json');

export function writeHookSettings() {
  const hooks: Record<string, unknown> = {};
  for (const event of EVENTS) {
    hooks[event] = [
      {
        matcher: '',
        hooks: [{ type: 'command', command: `"${slash(NODE_BIN)}" "${slash(HOOK_SCRIPT)}" ${event}`, timeout: 5 }],
      },
    ];
  }
  fs.writeFileSync(HOOK_SETTINGS, JSON.stringify({ hooks }, null, 2));
}

const base = (p: unknown) => (typeof p === 'string' ? path.basename(p) : '');
const short = (s: unknown, n = 90) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/** "Read" + {file_path} → "Liest server.ts" */
export function describeTool(name: string, input: any = {}): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return input.description ? short(input.description) : `Führt aus: ${short(input.command, 70)}`;
    case 'Read':
      return `Liest ${base(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
      return `Bearbeitet ${base(input.file_path)}`;
    case 'Write':
      return `Schreibt ${base(input.file_path)}`;
    case 'NotebookEdit':
      return `Bearbeitet ${base(input.notebook_path)}`;
    case 'Grep':
      return `Sucht nach „${short(input.pattern, 50)}“`;
    case 'Glob':
      return `Sucht Dateien ${short(input.pattern, 50)}`;
    case 'WebFetch':
      try {
        return `Liest ${new URL(input.url).hostname}`;
      } catch {
        return 'Liest eine Webseite';
      }
    case 'WebSearch':
      return `Sucht im Netz: ${short(input.query, 60)}`;
    case 'Task':
    case 'Agent':
      return `Startet Agent: ${short(input.description || input.subagent_type || '', 60)}`;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return 'Aktualisiert die Aufgabenliste';
    case 'Skill':
      return `Nutzt Skill ${short(input.skill, 40)}`;
    default:
      if (name.startsWith('mcp__')) return `Nutzt ${name.split('__').slice(2).join(' ') || name}`;
      return name;
  }
}

/** What Claude wants permission for, shown exactly (like the terminal does). */
export function describePermission(name: string, input: any = {}): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return `Möchte ausführen: ${short(input.command, 160)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
      return `Möchte ${base(input.file_path)} ändern`;
    case 'WebFetch':
      return `Möchte ${short(input.url, 120)} öffnen`;
    default:
      return `Möchte ${describeTool(name, input)}`;
  }
}

export function shorten(s: unknown, n = 160) {
  return short(s, n) || null;
}
