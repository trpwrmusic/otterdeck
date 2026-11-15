// Reads Claude Code's on-screen dialogs (permission prompts, AskUserQuestion) from the mirror terminal.
// Hooks don't always announce them (a Bash permission prompt can appear with no hook at all), so the
// screen is the source of truth: if it shows a menu with "Esc to cancel", Claude is waiting for you.
import type { Terminal } from '@xterm/headless';
import type { PermissionMode, PromptView } from '../shared/types.ts';

// Claude marks the selected option with ❯, Antigravity (agy) with >.
const OPTION = /^\s*([❯>]\s*)?(\d{1,2})\.\s+(.+?)\s*$/;
const FOOTER = /Esc to cancel|Enter to select|↑\/↓ to navigate|↑\/↓ Navigate/;
const RULE = /^[\s─━╌┄—-]+$/;

/** The unnumbered "Submit" under a multiple-choice list (it moves on to the next question). */
const SUBMIT = /^\s*(❯\s*)?(Submit|Next|Done)\s*$/i;
/** A multiple-choice box in front of an option: "[ ] Apfel", "[✔] Birne". */
const BOX = /^\[([^\]])\]\s*/;
/** The question bar of several questions: "←  ☒ Farbe  ☐ Früchte  ✔ Submit  →". */
const STEPS = /^\s*←?\s*([☐☒✔].*?)\s*→?\s*$/;

function parseSteps(text: string[]): PromptView['steps'] {
  const bar = text.find((l) => STEPS.test(l) && (l.match(/[☐☒]/g)?.length ?? 0) >= 2);
  if (!bar) return undefined;
  const steps: NonNullable<PromptView['steps']> = [];
  for (const m of bar.matchAll(/([☐☒✔])\s*([^☐☒✔→]+)/g)) {
    const label = m[2].trim();
    if (!label || /^submit$/i.test(label)) continue;
    steps.push({ label, done: m[1] === '☒' });
  }
  return steps.length >= 2 ? steps : undefined;
}

/**
 * The last page of several questions: "Review your answers", each question with its answer, then
 * "Ready to submit your answers?" with Submit / Cancel. It has no "Esc to cancel" footer.
 */
function parseReview(lines: string[]): PromptView | null {
  const head = lines.findIndex((l) => /^\s*Review your answers\s*$/i.test(l));
  const ready = lines.findIndex((l) => /Ready to submit your answers\?/i.test(l));
  if (head < 0 || ready < head) return null;
  const review: NonNullable<PromptView['review']> = [];
  for (let i = head + 1; i < ready; i++) {
    const q = lines[i].match(/^\s*●\s*(.+)$/);
    if (q) review.push({ question: q[1].trim(), answer: '' });
    const a = lines[i].match(/^\s*→\s*(.+)$/);
    if (a && review.length) review[review.length - 1].answer = a[1].trim();
  }
  const options: PromptView['options'] = [];
  let selected = -1;
  for (let i = ready + 1; i < lines.length; i++) {
    const m = lines[i].match(OPTION);
    if (!m) {
      if (options.length && lines[i].trim() && !/^\s{4,}/.test(lines[i])) break;
      continue;
    }
    options.push({ n: Number(m[2]), label: m[3].trim(), description: '' });
    if (m[1]) selected = Number(m[2]);
  }
  if (options.length < 2 || selected < 0) return null;
  return {
    kind: 'question',
    title: 'Antworten prüfen',
    detail: null,
    question: 'Antworten so abschicken?',
    options,
    selected,
    freeText: null,
    steps: parseSteps(lines.slice(Math.max(0, head - 3), head)),
    review,
  };
}

export function parsePrompt(screen: string[]): PromptView | null {
  const lines = screen.map((l) => l.replace(/\s+$/, ''));
  const review = parseReview(lines);
  if (review) return review;
  // The footer sits within the last few non-empty lines.
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last--;
  let footer = -1;
  for (let i = last; i >= Math.max(0, last - 5); i--) if (FOOTER.test(lines[i])) footer = i;
  if (footer < 0) return null;

  // Options: numbered lines above the footer, each followed by its indented description lines. A
  // multiple-choice list also has an unnumbered "Submit" between them. Options get their position
  // in the list as number (the cursor moves through them in that order), `num` keeps what the screen shows.
  interface Entry {
    line: number;
    num: number | null;
    label: string;
    cursor: boolean;
    action: boolean;
  }
  let entries: Entry[] = [];
  let top = footer;
  for (let i = footer - 1; i >= 0 && i >= footer - 40; i--) {
    const l = lines[i];
    if (!l.trim() || RULE.test(l)) continue;
    const sub = l.match(SUBMIT);
    if (sub && entries.length) {
      entries.unshift({ line: i, num: null, label: sub[2], cursor: !!sub[1], action: true });
      top = i;
      continue;
    }
    const m = l.match(OPTION);
    if (m) {
      entries.unshift({ line: i, num: Number(m[2]), label: m[3].replace(/\s+·\s+.*$/, '').trim(), cursor: !!m[1], action: false });
      top = i;
      continue;
    }
    // Indented lines between options are descriptions (read below); anything else ends the menu.
    if (entries.length && /^\s{4,}\S/.test(l)) continue;
    if (entries.length) break;
  }
  // Menus without numbers ("❯ No, exit" / "  Yes, I trust this folder"): the lines right above the
  // footer, one marked with ❯, the others indented the same way.
  if (entries.filter((e) => !e.action).length < 2) {
    entries = [];
    const block: Entry[] = [];
    let i = footer - 1;
    while (i >= 0 && !lines[i].trim()) i--;
    for (; i >= 0 && i >= footer - 12; i--) {
      const m = lines[i].match(/^\s*([❯>]\s+|\s{2,})(\S.*)$/);
      if (!m || !lines[i].trim() || /^\d{1,2}\./.test(m[2])) break;
      block.unshift({ line: i, num: null, label: m[2].trim(), cursor: /[❯>]/.test(m[1]), action: false });
    }
    if (block.length >= 2 && block.filter((b) => b.cursor).length === 1) {
      entries = block;
      top = block[0].line;
    }
  }
  if (entries.filter((e) => !e.action).length < 2 || !entries.some((e) => e.cursor)) return null;

  const options: PromptView['options'] = entries.map((e, k) => {
    const box = e.action ? null : e.label.match(BOX);
    // Descriptions: the indented lines right under an option (not the "Submit" line).
    const desc: string[] = [];
    if (e.num !== null)
      for (let i = e.line + 1; i < footer && !OPTION.test(lines[i]) && !SUBMIT.test(lines[i]) && /^\s{4,}\S/.test(lines[i]); i++)
        desc.push(lines[i].trim());
    return {
      n: k + 1,
      label: box ? e.label.slice(box[0].length).trim() : e.label,
      description: desc.join(' '),
      ...(box ? { checked: box[1].trim() !== '' } : {}),
      ...(e.action ? { action: true } : {}),
    };
  });
  const selected = entries.findIndex((e) => e.cursor) + 1;

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
  const steps = parseSteps(text);
  const multi = options.some((o) => o.checked !== undefined);
  const isQuestion = multi || !!steps || options.some((o) => /^type something/i.test(o.label)) || text.some((l) => /^[☐☒✔]/.test(l));
  const body = text.filter((l) => !STEPS.test(l));
  const question = [...body].reverse().find((l) => /\?$/.test(l)) ?? body.at(-1) ?? '';
  const header = body.filter((l) => l !== question && !/^Tip:/i.test(l));
  const freeText = options.find((o) => /^type something/i.test(o.label))?.n ?? null;
  const current = steps ? text.find((l) => STEPS.test(l)) : null;
  // The question's short header: in the bar the one not yet answered first, else "☐ Farbe" above it.
  const title = isQuestion
    ? (steps && current ? null : header.find((l) => /^[☐☒✔]/.test(l))?.replace(/^[☐☒✔]\s*/, '')) ?? null
    : header[0] ?? null;

  return {
    kind: isQuestion ? 'question' : 'permission',
    title,
    detail: isQuestion ? null : header.slice(1).join('\n') || null,
    question,
    options: options.filter((o) => !/^chat about this/i.test(o.label)),
    selected,
    freeText,
    ...(multi ? { multi: true } : {}),
    ...(steps ? { steps } : {}),
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

// ---------- first start and login (shown before any chat exists) ----------

/**
 * Claude Code's setup menus have no "Esc to cancel" footer: the theme choice, the login method, and
 * "Press Enter to continue" screens. They become a card like any other dialog.
 */
export function parseSetup(screen: string[]): PromptView | null {
  const lines = screen.map((l) => l.replace(/\s+$/, ''));
  const filled = lines.filter((l) => l.trim());
  // Only a menu at the bottom of the screen (where dialogs sit), not those words somewhere in a chat.
  let bottom = lines.length - 1;
  while (bottom >= 0 && !lines[bottom].trim()) bottom--;
  const at = lines.findIndex((l, i) => i >= bottom - 22 && /^\s*(Select login method:|Choose the text style)/i.test(l));
  if (at >= 0) {
    const login = /login method/i.test(lines[at]);
    const options: PromptView['options'] = [];
    let selected = -1;
    for (let i = at + 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l.trim()) {
        if (options.length) break;
        continue;
      }
      if (/^[\s╌┄─]+$/.test(l)) break;
      // Options are indented or carry the cursor; text before them ("To change this later …") is skipped.
      if (!/^\s*❯/.test(l) && !/^\s{3,}\S/.test(l)) {
        if (options.length) break;
        continue;
      }
      const m = l.match(/^\s*(❯\s*)?(?:(\d{1,2})\.\s+)?(?:✔\s*)?(\S.*)$/);
      if (!m) break;
      const n = m[2] ? Number(m[2]) : options.length + 1;
      const [label, ...rest] = m[3].split(' · ');
      options.push({ n, label: label.trim(), description: rest.join(' · ').trim() });
      if (m[1]) selected = n;
    }
    if (options.length < 2 || selected < 0) return null;
    return {
      kind: 'question',
      title: login ? 'Anmeldung' : 'Erster Start',
      detail: null,
      question: login ? 'Wie soll sich Claude anmelden?' : 'Welche Farben soll das Terminal nutzen?',
      options: options.map((o) => ({ ...o, label: germanSetup(o.label), description: germanSetup(o.description) })),
      selected,
      freeText: null,
    };
  }
  // "Login successful. Press Enter to continue…", security notes and similar one-key screens.
  const tail = filled.slice(-3).join('\n');
  if (/Press Enter to continue/i.test(tail)) {
    const idx = lines.findLastIndex((l) => /Press Enter to continue/i.test(l));
    const before = lines
      .slice(Math.max(0, idx - 8), idx)
      .map((l) => l.trim())
      .filter((l) => l && !/^[╌┄─.]+$/.test(l));
    const question = /Login successful/i.test(lines.join('\n')) ? 'Anmeldung erfolgreich.' : before.at(-1) ?? 'Weiter?';
    return { kind: 'question', title: 'Erster Start', detail: null, question, options: [{ n: 1, label: 'Weiter', description: '' }], selected: 1, freeText: null };
  }
  return null;
}

function germanSetup(s: string) {
  return s
    .replace(/^Claude account with subscription$/i, 'Claude-Konto mit Abo')
    .replace(/^Anthropic Console account$/i, 'Anthropic-Console-Konto')
    .replace(/^API usage billing$/i, 'Abrechnung nach API-Nutzung')
    .replace(/^3rd-party platform$/i, 'Andere Plattform')
    .replace(/^Auto \(match terminal\)$/i, 'Automatisch (wie das Terminal)')
    .replace(/^Dark mode/i, 'Dunkel')
    .replace(/^Light mode/i, 'Hell')
    .replace(/\(colorblind-friendly\)/i, '(farbenblind-freundlich)')
    .replace(/\(ANSI colors only\)/i, '(nur ANSI-Farben)');
}

/**
 * The sign-in link Claude Code shows ("Browser didn't open? Use the url below …"), joined back
 * together where the terminal wrapped it, and whether it waits for a pasted code.
 */
export function parseLogin(screen: string[]): { url: string; code: boolean } | null {
  const lines = screen.map((l) => l.replace(/\s+$/, ''));
  const start = lines.findIndex((l) => /https:\/\/\S*(oauth|authorize|login)/i.test(l));
  if (start < 0) return null;
  let url = lines[start].trim().replace(/^.*?(https:\/\/)/, '$1');
  // Wrapped: the following lines continue the URL without spaces until an empty line.
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || /\s/.test(t) || !/^[\w%&=.~:/?#@!$'()*+,;-]+$/.test(t)) break;
    url += t;
  }
  const code = lines.some((l) => /Paste code here/i.test(l));
  if (!/^https:\/\/[^\s]+$/.test(url)) return null;
  return { url, code };
}

/**
 * Claude Code's suggestion for your next message: dimmed text in the empty input box, accepted there
 * with Tab/Enter. Text you typed yourself is not dimmed, so it never counts as a suggestion.
 */
export function readSuggestion(t: Terminal): string | null {
  const buf = t.buffer.active;
  const rule = (y: number) => /^\s*─{20,}\s*$/.test(buf.getLine(y)?.translateToString(true) ?? '');
  // The input box: a line starting with ">" or "❯" right under a rule, near the bottom.
  let y = -1;
  for (let i = t.rows - 1; i >= 0; i--) {
    const line = buf.viewportY + i;
    if (/^\s*[>❯]\s/.test(buf.getLine(line)?.translateToString(true) ?? '') && rule(line - 1)) {
      y = line;
      break;
    }
  }
  if (y < 0) return null;
  let text = '';
  for (let line = y; line < buf.viewportY + t.rows && !rule(line); line++) {
    const row = buf.getLine(line);
    if (!row) break;
    const start = line === y ? (row.translateToString(true).match(/^\s*[>❯]\s/)?.[0].length ?? 2) : 0;
    let part = '';
    for (let x = start; x < t.cols; x++) {
      const cell = row.getCell(x);
      if (!cell) break;
      const ch = cell.getChars();
      if (ch && ch.trim() && !cell.isDim()) return null; // typed by you
      part += ch || ' ';
    }
    text += (text && !row.isWrapped ? '\n' : '') + part.replace(/\s+$/, '');
  }
  text = text.trim();
  // The start screen's examples (Try "…") are hints, not a next step.
  if (/^Try "/.test(text)) return null;
  return text || null;
}

/**
 * Several questions: which tab of the question bar is active. Claude Code puts the active one on a
 * coloured background. Returns its index (the questions, then "Submit" = the review page) or null.
 */
export function readStepCursor(t: Terminal): number | null {
  const buf = t.buffer.active;
  for (let i = t.rows - 1; i >= 0; i--) {
    const row = buf.getLine(buf.viewportY + i);
    const text = row?.translateToString(true) ?? '';
    if (!row || !STEPS.test(text) || (text.match(/[☐☒]/g)?.length ?? 0) < 2) continue;
    // Walk the bar: each tab starts with ☐/☒/✔; the active one has a background colour.
    let index = -1;
    for (let x = 0; x < t.cols; x++) {
      const cell = row.getCell(x);
      if (!cell) break;
      const ch = cell.getChars();
      if (/[☐☒✔]/.test(ch)) {
        index++;
        if (!cell.isBgDefault() || cell.isInverse()) return index;
      }
    }
    return null;
  }
  return null;
}
