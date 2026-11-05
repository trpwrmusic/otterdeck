// Which models each provider offers, for the "new chat" picker and the model switcher in the chat.
import { execFile } from 'node:child_process';
import { AGY_AVAILABLE, AGY_BIN } from './agy.ts';
import type { ModelChoice, Provider } from '../shared/types.ts';

/** Claude Code takes these with --model and /model. */
const CLAUDE: ModelChoice[] = [
  { provider: 'claude', id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Stärkstes Modell' },
  { provider: 'claude', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Schnell und gut' },
  { provider: 'claude', id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'Am schnellsten' },
  { provider: 'claude', id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'Schreiben' },
];

let agyList: ModelChoice[] = [];
let agyAt = 0;

/** `agy models` prints "slug<TAB>Label" per line. */
function loadAgy(): Promise<ModelChoice[]> {
  return new Promise((resolve) => {
    if (!AGY_AVAILABLE) return resolve([]);
    execFile(AGY_BIN, ['models'], { timeout: 30_000, windowsHide: true, encoding: 'utf8' }, (_err, stdout) => {
      const list: ModelChoice[] = [];
      for (const line of String(stdout ?? '').split(/\r?\n/)) {
        const m = line.match(/^([a-z0-9][\w.-]+)\t(.+)$/i);
        if (m) list.push({ provider: 'agy', id: m[1], label: m[2].trim() });
      }
      resolve(list);
    });
  });
}

export async function models(): Promise<Record<Provider, ModelChoice[]>> {
  if (AGY_AVAILABLE && (!agyList.length || Date.now() - agyAt > 6 * 3600_000)) {
    const fresh = await loadAgy();
    if (fresh.length) {
      agyList = fresh;
      agyAt = Date.now();
    }
  }
  return { claude: CLAUDE, agy: agyList };
}

/** Accept only model ids a provider really offers (they go onto a command line). */
export async function validModel(provider: Provider, id: unknown): Promise<string | undefined> {
  if (typeof id !== 'string' || !/^[\w.-]{2,80}$/.test(id)) return undefined;
  const list = (await models())[provider];
  return list.some((m) => m.id === id) ? id : undefined;
}

export function claudeLabel(id: string) {
  return CLAUDE.find((m) => m.id === id)?.label ?? id;
}
