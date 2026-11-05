import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu, Orbit, Sparkles } from 'lucide-react';
import type { ModelChoice, Provider, TabView } from '../../shared/types';
import { api, usePersisted } from './api';

// ---------- the model list (loaded once) ----------

let cache: Record<Provider, ModelChoice[]> | null = null;
let loading: Promise<Record<Provider, ModelChoice[]>> | null = null;

export function useModels() {
  const [list, setList] = useState(cache);
  useEffect(() => {
    if (cache) return;
    loading ??= api.models().then((m) => (cache = m));
    loading.then(setList).catch(() => {});
  }, []);
  return list;
}

export const PROVIDER_LABEL: Record<Provider, string> = { claude: 'Claude', agy: 'Antigravity' };
export const ProviderIcon = ({ provider, size = 15 }: { provider: Provider; size?: number }) =>
  provider === 'agy' ? <Orbit size={size} /> : <Sparkles size={size} />;

/** agy lists every model three times (Low/Medium/High): group them into one row with effort chips. */
function grouped(list: ModelChoice[]) {
  const rows = new Map<string, { base: string; variants: { effort: string; m: ModelChoice }[] }>();
  for (const m of list) {
    const g = m.label.match(/^(.*?)\s*\((Low|Medium|High|Max)\)$/i);
    const base = g ? g[1] : m.label;
    const row = rows.get(base) ?? { base, variants: [] };
    row.variants.push({ effort: g ? g[2] : '', m });
    rows.set(base, row);
  }
  const order = ['low', 'medium', 'high', 'max'];
  for (const r of rows.values()) r.variants.sort((a, b) => order.indexOf(a.effort.toLowerCase()) - order.indexOf(b.effort.toLowerCase()));
  return [...rows.values()];
}

const EFFORT: Record<string, string> = { low: 'wenig', medium: 'mittel', high: 'viel', max: 'max' };

export interface NewChatChoice {
  provider: Provider;
  /** null = the CLI's own default model */
  model: string | null;
}

export function choiceLabel(c: NewChatChoice, models: Record<Provider, ModelChoice[]> | null) {
  const m = models?.[c.provider].find((x) => x.id === c.model);
  return m ? m.label.replace(/\s*\((Low|Medium|High|Max)\)$/i, (_, e) => ` · ${EFFORT[e.toLowerCase()] ?? e}`) : 'Standardmodell';
}

/** The list itself: providers as sections, models as rows (agy with effort chips). */
function ModelList({
  providers,
  models,
  current,
  onPick,
}: {
  providers: Provider[];
  models: Record<Provider, ModelChoice[]> | null;
  current: NewChatChoice | null;
  onPick: (c: NewChatChoice) => void;
}) {
  if (!models) return <div className="model-empty">Lädt …</div>;
  return (
    <>
      {providers.map((p) => (
        <div key={p} className="model-section">
          {providers.length > 1 && (
            <div className="model-provider">
              <ProviderIcon provider={p} size={13} /> {PROVIDER_LABEL[p]}
            </div>
          )}
          <button className={`model-row${current?.provider === p && !current.model ? ' sel' : ''}`} onClick={() => onPick({ provider: p, model: null })}>
            <span className="model-name">Standard</span>
            <span className="model-hint">{p === 'claude' ? 'Voreinstellung von Claude Code' : 'Voreinstellung von Antigravity'}</span>
            {current?.provider === p && !current.model && <Check size={14} className="model-check" />}
          </button>
          {p === 'agy'
            ? grouped(models.agy).map((row) => (
                <div key={row.base} className="model-row group">
                  <span className="model-name">{row.base}</span>
                  <span className="model-efforts">
                    {row.variants.map((v) => (
                      <button
                        key={v.m.id}
                        className={`effort${current?.model === v.m.id ? ' sel' : ''}`}
                        title={v.m.label}
                        onClick={() => onPick({ provider: 'agy', model: v.m.id })}
                      >
                        {EFFORT[v.effort.toLowerCase()] ?? (v.effort || 'Start')}
                      </button>
                    ))}
                  </span>
                </div>
              ))
            : models.claude.map((m) => (
                <button key={m.id} className={`model-row${current?.model === m.id ? ' sel' : ''}`} onClick={() => onPick({ provider: 'claude', model: m.id })}>
                  <span className="model-name">{m.label}</span>
                  {m.hint && <span className="model-hint">{m.hint}</span>}
                  {current?.model === m.id && <Check size={14} className="model-check" />}
                </button>
              ))}
        </div>
      ))}
    </>
  );
}

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [open]);
  return { open, setOpen, ref };
}

/**
 * "Neuer Chat" split button: the main part starts a chat with your last choice, the arrow opens the
 * provider/model list (picking one starts right away and becomes the new default).
 */
export function NewChatButton({
  agy,
  big,
  disabled,
  onStart,
  onContextMenu,
  title,
}: {
  agy: boolean;
  big?: boolean;
  disabled?: boolean;
  onStart: (c: NewChatChoice) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  title?: string;
}) {
  const models = useModels();
  const [choice, setChoice] = usePersisted<NewChatChoice>('otter.newChat', { provider: 'claude', model: null });
  const c: NewChatChoice = choice.provider === 'agy' && !agy ? { provider: 'claude', model: null } : choice;
  const { open, setOpen, ref } = usePopover();
  const providers: Provider[] = agy ? ['claude', 'agy'] : ['claude'];
  return (
    <div className={`newchat${big ? ' big' : ''}`} ref={ref}>
      <button
        className={`btn ${big ? 'big' : 'small'} primary newchat-main`}
        disabled={disabled}
        onClick={() => onStart(c)}
        onContextMenu={onContextMenu}
        title={title ?? `Neuer Chat: ${PROVIDER_LABEL[c.provider]}, ${choiceLabel(c, models)}`}
      >
        <ProviderIcon provider={c.provider} size={big ? 18 : 15} />
        <span className="newchat-label">{big ? `${PROVIDER_LABEL[c.provider]} starten` : PROVIDER_LABEL[c.provider]}</span>
        {c.model && <span className="newchat-model">{choiceLabel(c, models)}</span>}
      </button>
      <button className={`btn ${big ? 'big' : 'small'} primary newchat-more`} disabled={disabled} onClick={() => setOpen(!open)} aria-label="Anbieter und Modell wählen" title="Anbieter und Modell wählen">
        <ChevronDown size={big ? 16 : 14} />
      </button>
      {open && (
        <div className="model-menu" role="menu">
          <ModelList
            providers={providers}
            models={models}
            current={c}
            onPick={(next) => {
              setChoice(next);
              setOpen(false);
              onStart(next);
            }}
          />
        </div>
      )}
    </div>
  );
}

/** In the chat box next to the mode: which model this session runs with, and switching it. */
export function ModelMenu({ tab }: { tab: TabView }) {
  const models = useModels();
  const { open, setOpen, ref } = usePopover();
  const [error, setError] = useState<string | null>(null);
  const provider: Provider = tab.kind === 'agy' ? 'agy' : 'claude';
  const busy = tab.status === 'working' || tab.status === 'waiting';
  const label = (tab.model ?? (tab.modelId ? models?.[provider].find((m) => m.id === tab.modelId)?.label : null) ?? 'Modell').replace(/^Claude\s+/, '');
  return (
    <div className="model-switch" ref={ref}>
      <button className="mode-btn" onClick={() => setOpen(!open)} title={busy ? 'Modell wechseln geht, wenn die Sitzung nicht arbeitet' : 'Modell wechseln'}>
        <Cpu size={14} />
        <span className="mode-btn-label">{label}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="model-menu up" role="menu">
          {busy && <div className="model-note">Arbeitet gerade. Wechseln geht danach.</div>}
          {provider === 'agy' && <div className="model-note">Antigravity startet dafür kurz neu, der Chat geht weiter.</div>}
          <ModelList
            providers={[provider]}
            models={models}
            current={{ provider, model: tab.modelId }}
            onPick={(next) => {
              if (busy || !next.model) return setOpen(false);
              setError(null);
              api
                .setModel(tab.id, next.model)
                .then(() => setOpen(false))
                .catch((err) => setError(err.message));
            }}
          />
          {error && <div className="mode-error">{error}</div>}
        </div>
      )}
    </div>
  );
}
