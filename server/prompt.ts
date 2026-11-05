// Reads Claude Code's on-screen dialogs (permission prompts, AskUserQuestion) from the mirror terminal.
// Hooks don't always announce them (a Bash permission prompt can appear with no hook at all), so the
// screen is the source of truth: if it shows a menu with "Esc to cancel", Claude is waiting for you.
import type { PermissionMode, PromptView } from '../shared/types.ts';

const OPTION = /^\s*(❯\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
const FOOTER = /Esc to cancel|Enter to select|↑\/↓ to navigate/;
const RULE = /^[\s─━╌┄—-]+$/;

export function parsePrompt(screen: string[]): PromptView | null {
  const lines = screen.map((l) => l.replace(/\s+$/, ''));
  // The footer sits within the last few non-empty lines.
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  let footer = -1;
  for (let i = last; i >= Math.max(0, last - 5); i--) if (FOOTER.test(lines[i])) footer = i;
  if (footer < 0) return null;

  // Options: numbered lines above the footer, each followed by its indented description lines.
  const options: PromptView['options'] = [];
  let selected = -1;
  let top = footer;
  for (let i = footer - 1; i >= 0 && i >= footer - 40; i--) {
    const l = lines[i];
    if (!l.trim() || RULE.test(l)) continue;
    const m = l.match(OPTION);
    if (m) {
      options.unshift({ n: Number(m[2]), label: m[3].replace(/\s+·\s+.*$/, '').trim(), description: '' });
      if (m[1]) selected = Number(m[2]);
      top = i;
      continue;
    }
    // Indented lines between options are descriptions (read below); anything else ends the menu.
    if (options.length && /^\s{4,}\S/.test(l)) continue;
    if (options.length) break;
  }
  if (options.length < 2 || selected < 0) return null;

  // Descriptions: the indented lines right under each option line.
  const optionLine = new Map<number, number>();
  for (let i = top; i < footer; i++) {
    const m = lines[i].match(OPTION);
    if (m) optionLine.set(Number(m[2]), i);
  }
  for (const o of options) {
    const at = optionLine.get(o.n);
    if (at === undefined) continue;
    const desc: string[] = [];
    for (let i = at + 1; i < footer && !OPTION.test(lines[i]) && /^\s{4,}\S/.test(lines[i]); i++) desc.push(lines[i].trim());
    o.description = desc.join(' ');
  }

  // Above the options: the question, and for permissions the tool, its summary and the command.
  const above: string[] = [];
  for (let i = top - 1; i >= 0 && i >= top - 30; i--) {
    const l = lines[i];
    if (/^─{10,}/.test(l.trim())) break; // the line that opens the dialog
    above.unshift(l);
  }
  // Trim, and drop the box-drawing edge Claude puts in front of wrapped command lines.
  const text = above
    .filter((l) => l.trim() && !/^[╌┄]{6,}/.test(l.trim()))
    .map((l) => l.trim().replace(/^[│┃|]\s?/, ''))
    .filter(Boolean);
  const isQuestion = options.some((o) => /^type something/i.test(o.label)) || text.some((l) => /^[☐☒✔]/.test(l));
  const question = [...text].reverse().find((l) => /\?$/.test(l)) ?? text.at(-1) ?? '';
  const header = text.filter((l) => l !== question && !/^Tip:/i.test(l));
  const freeText = options.find((o) => /^type something/i.test(o.label))?.n ?? null;

  return {
    kind: isQuestion ? 'question' : 'permission',
    title: isQuestion ? header.find((l) => /^[☐☒✔]/.test(l))?.replace(/^[☐☒✔]\s*/, '') ?? null : header[0] ?? null,
    detail: isQuestion ? null : header.slice(1).join('\n') || null,
    question,
    options: options.filter((o) => !/^chat about this/i.test(o.label)),
    selected,
    freeText,
  };
}

export function promptSummary(p: PromptView): string {
  if (p.kind === 'question') return p.question;
  const cmd = p.detail?.split('\n').at(-1);
  return cmd ? `Möchte: ${cmd}` : p.question;
}

/**
 * The permission mode from Claude Code's footer: "⏵⏵ auto mode on", "⏵⏵ accept edits on",
 * "⏸ plan mode on", "bypass permissions on". A footer that shows the input hints but no mode
 * means the default mode (Claude asks before acting).
 */
export function parseMode(screen: string[]): PermissionMode | null {
  // The footer is the last text on screen; below it there can be many empty rows.
  const tail = screen.filter((l) => l.trim()).slice(-4).join('\n');
  if (/bypass permissions on/i.test(tail)) return 'bypass';
  if (/auto mode on/i.test(tail)) return 'auto';
  if (/accept edits on/i.test(tail)) return 'acceptEdits';
  if (/plan mode on/i.test(tail)) return 'plan';
  if (/manual mode on/i.test(tail)) return 'default';
  // The idle input box with its hint line and no mode in it.
  if (/\? for shortcuts|esc to interrupt/i.test(tail) || /^\s*❯\s*$/m.test(tail)) return 'default';
  return null;
}
