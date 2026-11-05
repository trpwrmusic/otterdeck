import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, ChevronLeft, ChevronRight, Cpu, Orbit, Plus, Settings, Sparkles } from 'lucide-react';
import type { AccountView, ModelChoice, Provider, TabView } from '../../shared/types';
import { api, usePersisted } from './api';
import { MODES, modeOf } from './chat/Composer';

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

/** agy's "effort": how long the model thinks before it answers. */
const EFFORT: Record<string, string> = { low: 'schnell', medium: 'normal', high: 'gründlich', max: 'maximal' };
const EFFORTS = ['low', 'medium', 'high'];
const effortOf = (label: string) => label.match(/\((Low|Medium|High|Max)\)$/i)?.[1].toLowerCase() ?? null;
/** The variant of a model with this effort, or the nearest one it has. */
function variantFor(row: { variants: { effort: string; m: ModelChoice }[] }, effort: string) {
  const order = ['low', 'medium', 'high', 'max'];
  const want = order.indexOf(effort);
  return [...row.variants].sort((a, b) => Math.abs(order.indexOf(a.effort.toLowerCase()) - want) - Math.abs(order.indexOf(b.effort.toLowerCase()) - want))[0];
}
const EFFORT_NOTE = 'Gilt für alle Modelle. Gründlich ist bei schweren Aufgaben besser, aber langsamer.';
const CLAUDE_EFFORT_NOTE = 'Standard nimmt die Einstellung des Kontos. Gründlich ist bei schweren Aufgaben besser, aber langsamer.';

/** The "Nachdenken" switch. With `withDefault` a "Standard" field (= the account's setting, value null) comes first. */
function EffortBar({ value, onChange, withDefault, note }: { value: string | null; onChange: (e: string | null) => void; withDefault?: boolean; note: string }) {
  const options: (string | null)[] = withDefault ? [null, ...EFFORTS] : EFFORTS;
  return (
    <div className="effort-bar">
      <div className="effort-head">Nachdenken</div>
      <div className="seg">
        {options.map((e) => (
          <button key={e ?? 'std'} className={value === e ? 'on' : ''} onClick={() => onChange(e)}>
            {e ? EFFORT[e] : 'Standard'}
          </button>
        ))}
      </div>
      <div className="model-note effort-note">{note}</div>
    </div>
  );
}

export interface NewChatChoice {
  provider: Provider;
  /** null = the CLI's own default model */
  model: string | null;
  /** Claude account dir (null = default account). */
  account?: string | null;
  /** Claude's thinking effort (null = the account's setting). */
  effort?: string | null;
}

export function choiceLabel(c: NewChatChoice, models: Record<Provider, ModelChoice[]> | null) {
  const m = models?.[c.provider].find((x) => x.id === c.model);
  return m ? m.label.replace(/\s*\((Low|Medium|High|Max)\)$/i, (_, e) => ` · ${EFFORT[e.toLowerCase()] ?? e}`) : 'Standardmodell';
}

/** The list itself: providers as sections, models as rows (Antigravity with one effort switch on top). */
function ModelList({
  providers,
  models,
  current,
  onPick,
  claudeEffort,
  onClaudeEffort,
}: {
  providers: Provider[];
  models: Record<Provider, ModelChoice[]> | null;
  current: NewChatChoice | null;
  onPick: (c: NewChatChoice) => void;
  /** Claude's effort switch: shown when onClaudeEffort is given. */
  claudeEffort?: string | null;
  onClaudeEffort?: (e: string | null) => void;
}) {
  // One "think" level for all Antigravity models (remembered); starts at the current model's level.
  const currentEffort = current?.provider === 'agy' ? effortOf(models?.agy.find((m) => m.id === current.model)?.label ?? '') : null;
  const [effort, setEffort] = usePersisted<string>('otter.agyEffort', currentEffort ?? 'medium');
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
          {p === 'claude' && onClaudeEffort && <EffortBar withDefault value={claudeEffort ?? null} onChange={onClaudeEffort} note={CLAUDE_EFFORT_NOTE} />}
          {p === 'agy' && <EffortBar value={effort} onChange={(e) => setEffort(e ?? 'medium')} note={EFFORT_NOTE} />}
          <button className={`model-row${current?.provider === p && !current.model ? ' sel' : ''}`} onClick={() => onPick({ provider: p, model: null, effort: p === 'claude' ? claudeEffort ?? null : undefined })}>
            <span className="model-name">Standard</span>
            <span className="model-hint">{p === 'claude' ? 'Voreinstellung von Claude Code' : 'Voreinstellung von Antigravity'}</span>
            {current?.provider === p && !current.model && <Check size={14} className="model-check" />}
          </button>
          {p === 'agy'
            ? grouped(models.agy).map((row) => {
                const v = variantFor(row, effort);
                const sel = row.variants.some((x) => x.m.id === current?.model);
                return (
                  <button key={row.base} className={`model-row${sel ? ' sel' : ''}`} onClick={() => onPick({ provider: 'agy', model: v.m.id })} title={v.m.label}>
                    <span className="model-name">{row.base}</span>
                    {v.effort && v.effort.toLowerCase() !== effort && <span className="model-hint">nur {EFFORT[v.effort.toLowerCase()] ?? v.effort}</span>}
                    {sel && <Check size={14} className="model-check" />}
                  </button>
                );
              })
            : models.claude.map((m) => (
                <button key={m.id} className={`model-row${current?.model === m.id ? ' sel' : ''}`} onClick={() => onPick({ provider: 'claude', model: m.id, effort: claudeEffort ?? null })}>
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

/** One choice in the new-chat popup: Claude per account, Antigravity. */
interface ProviderOption {
  provider: Provider;
  account: string | null;
  label: string;
  sub: string;
}

/**
 * New chat: on the left your last choice as text (one click starts it), on the right a "+" that opens
 * a popup: first the provider (Claude per account, Antigravity), then the model. Picking a model
 * starts the chat and becomes the new last choice.
 */
export function NewChatButton({
  agy,
  accounts,
  big,
  disabled,
  onStart,
}: {
  agy: boolean;
  accounts: AccountView[];
  big?: boolean;
  disabled?: boolean;
  onStart: (c: NewChatChoice) => void;
}) {
  const models = useModels();
  const [choice, setChoice] = usePersisted<NewChatChoice>('otter.newChat', { provider: 'claude', model: null, account: null });
  const c: NewChatChoice = choice.provider === 'agy' && !agy ? { provider: 'claude', model: null, account: null } : choice;
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<ProviderOption | null>(null);
  const [claudeEffort, setClaudeEffort] = usePersisted<string | null>('otter.claudeEffort', null);

  const options: ProviderOption[] = [
    ...(accounts.length ? accounts : [{ dir: '', label: 'Standard', email: null, isDefault: true }]).map((a) => ({
      provider: 'claude' as const,
      // The account is always named, so "Claude · Standard" doesn't fall back to the project's account.
      account: a.dir || null,
      label: accounts.length > 1 ? `Claude · ${a.label}` : 'Claude',
      sub: a.email ?? 'Claude Code',
    })),
    ...(agy ? [{ provider: 'agy' as const, account: null, label: 'Antigravity', sub: 'Google · Gemini, Claude, GPT-OSS' }] : []),
  ];
  const optionOf = (x: NewChatChoice) => options.find((o) => o.provider === x.provider && (o.account ?? null) === (x.account ?? null)) ?? options[0];
  const current = optionOf(c);

  useEffect(() => {
    if (!open) return;
    setStep(null);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  const start = (next: NewChatChoice) => {
    setChoice(next);
    setOpen(false);
    onStart(next);
  };
  const text = [current.label, c.model ? choiceLabel(c, models) : null, c.provider === 'claude' && c.effort ? EFFORT[c.effort] : null].filter(Boolean).join(' · ');

  return (
    <div className={`newchat${big ? ' big' : ''}`}>
      <button className={`btn ${big ? 'big' : 'small'} primary newchat-main`} disabled={disabled} onClick={() => onStart(c)} title={`Neuer Chat: ${text}`}>
        <ProviderIcon provider={c.provider} size={big ? 18 : 15} />
        <span className="newchat-label">{text}</span>
      </button>
      <button className={`btn ${big ? 'big' : 'small'} primary newchat-more`} disabled={disabled} onClick={() => setOpen(true)} aria-label="Neuer Chat mit …" title="Neuer Chat mit anderem Anbieter oder Modell">
        <Plus size={big ? 18 : 15} />
      </button>
      {open && (
        <div className="dialog-scrim" onClick={() => setOpen(false)}>
          <div className="dialog newchat-dialog" role="dialog" aria-label="Neuer Chat" onClick={(e) => e.stopPropagation()}>
            {!step ? (
              <>
                <div className="dialog-title">Neuer Chat mit …</div>
                <div className="provider-list">
                  {options.map((o) => (
                    <button key={o.provider + (o.account ?? '')} className={`provider-card${o === current ? ' sel' : ''}`} onClick={() => setStep(o)}>
                      <span className="provider-icon">
                        <ProviderIcon provider={o.provider} size={18} />
                      </span>
                      <span className="provider-text">
                        <span className="provider-name">{o.label}</span>
                        <span className="provider-sub">{o.sub}</span>
                      </span>
                      <ChevronRight size={16} className="provider-go" />
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="dialog-title">
                  <button className="icon-btn dialog-back" onClick={() => setStep(null)} aria-label="Zurück">
                    <ChevronLeft size={18} />
                  </button>
                  {step.label}
                </div>
                <div className="newchat-models">
                  <ModelList
                    providers={[step.provider]}
                    models={models}
                    current={c.provider === step.provider && (c.account ?? null) === step.account ? c : null}
                    onPick={(next) => start({ ...next, account: step.account })}
                    claudeEffort={claudeEffort}
                    onClaudeEffort={setClaudeEffort}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The models of this tab's provider; picking one switches the running session. */
export function ModelSwitchList({ tab, onDone }: { tab: TabView; onDone?: () => void }) {
  const models = useModels();
  const [error, setError] = useState<string | null>(null);
  const provider: Provider = tab.kind === 'agy' ? 'agy' : 'claude';
  const busy = tab.status === 'working' || tab.status === 'waiting';
  return (
    <>
      {busy && <div className="model-note">Arbeitet gerade. Wechseln geht danach.</div>}
      {provider === 'agy' && <div className="model-note">Antigravity startet dafür kurz neu, der Chat geht weiter.</div>}
      <ModelList
        providers={[provider]}
        models={models}
        current={{ provider, model: tab.modelId }}
        claudeEffort={tab.effort}
        onClaudeEffort={
          provider === 'claude'
            ? (e) => {
                if (busy || !e) return;
                setError(null);
                api.setEffort(tab.id, e).catch((err) => setError(err.message));
              }
            : undefined
        }
        onPick={(next) => {
          if (busy || !next.model) return onDone?.();
          setError(null);
          api
            .setModel(tab.id, next.model)
            .then(() => onDone?.())
            .catch((err) => setError(err.message));
        }}
      />
      {error && <div className="mode-error">{error}</div>}
    </>
  );
}

export function modelLabel(tab: TabView, models: Record<Provider, ModelChoice[]> | null) {
  const provider: Provider = tab.kind === 'agy' ? 'agy' : 'claude';
  return (tab.model ?? (tab.modelId ? models?.[provider].find((m) => m.id === tab.modelId)?.label : null) ?? 'Standard').replace(/^Claude\s+/, '');
}

/** In the chat box next to the mode: which model this session runs with, and switching it. */
export function ModelMenu({ tab }: { tab: TabView }) {
  const models = useModels();
  const { open, setOpen, ref } = usePopover();
  const busy = tab.status === 'working' || tab.status === 'waiting';
  return (
    <div className="model-switch" ref={ref}>
      <button className="mode-btn" onClick={() => setOpen(!open)} title={busy ? 'Modell wechseln geht, wenn die Sitzung nicht arbeitet' : 'Modell wechseln'}>
        <Cpu size={14} />
        <span className="mode-btn-label">{modelLabel(tab, models)}</span>
        <ChevronDown size={13} />
      </button>
      {open && (
        <div className="model-menu up" role="menu">
          <ModelSwitchList tab={tab} onDone={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

/** Short words for the mode switch in the phone sheet. */
const MODE_SHORT: Record<string, string> = { default: 'Fragt', acceptEdits: 'Bearbeiten', plan: 'Plan', auto: 'Auto' };

/**
 * Phone: one small round settings button instead of two chips. It opens a compact sheet as wide as
 * the chat box: models as chips (Antigravity with its effort below), the mode as one 4-way switch.
 * A model change applies with "Wechseln" (Antigravity restarts for it); the mode switches at once.
 */
export function ComposerSheet({ tab }: { tab: TabView }) {
  const models = useModels();
  const [open, setOpen] = useState(false);
  const provider: Provider = tab.kind === 'agy' ? 'agy' : 'claude';
  const busy = tab.status === 'working' || tab.status === 'waiting';
  const [pick, setPick] = useState<string | null>(tab.modelId);
  const [error, setError] = useState<string | null>(null);
  const [modeBusy, setModeBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPick(tab.modelId);
      setError(null);
    }
  }, [open, tab.modelId]);

  const list = models?.[provider] ?? [];
  const rows = provider === 'agy' ? grouped(list) : list.map((m) => ({ base: m.label, variants: [{ effort: '', m }] }));
  const pickedRow = rows.find((r) => r.variants.some((v) => v.m.id === pick)) ?? null;

  const chooseBase = (row: (typeof rows)[number]) => {
    // A model with efforts starts at "medium" (or what it has).
    const v = row.variants.find((x) => /medium/i.test(x.effort)) ?? row.variants[0];
    setPick(v.m.id);
  };
  const applyModel = async () => {
    if (!pick || pick === tab.modelId || busy) return;
    setError(null);
    try {
      await api.setModel(tab.id, pick);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const setMode = async (id: string) => {
    setModeBusy(true);
    setError(null);
    try {
      await api.setMode(tab.id, id as any);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setModeBusy(false);
    }
  };
  const mode = modeOf(tab);

  return (
    <>
      <button className={`round-btn plain sheet-btn${open ? ' on' : ''}`} onClick={() => setOpen(!open)} aria-label="Modell und Modus" title={`${modelLabel(tab, models)} · ${mode?.label ?? 'Modus'}`}>
        <Settings size={18} />
      </button>
      {open && (
        <>
          <div className="sheet-scrim" onClick={() => setOpen(false)} />
          <div className="composer-sheet compact" role="dialog" aria-label="Modell und Modus">
            <div className="sheet-head">
              <span>Modell</span>
              <span className="sheet-now">{modelLabel(tab, models)}</span>
            </div>
            <div className="chip-row">
              <button className={`chip${!pick ? ' sel' : ''}`} onClick={() => setPick(null)}>
                Standard
              </button>
              {rows.map((r) => (
                <button key={r.base} className={`chip${pickedRow?.base === r.base ? ' sel' : ''}`} onClick={() => chooseBase(r)}>
                  {r.base.replace(/^Claude\s+/, '')}
                </button>
              ))}
            </div>
            {pickedRow && pickedRow.variants.length > 1 && <div className="sheet-sub">Nachdenken</div>}
            {pickedRow && pickedRow.variants.length > 1 && (
              <div className="seg">
                {pickedRow.variants.map((v) => (
                  <button key={v.m.id} className={v.m.id === pick ? 'on' : ''} onClick={() => setPick(v.m.id)}>
                    {EFFORT[v.effort.toLowerCase()] ?? v.effort}
                  </button>
                ))}
              </div>
            )}
            {provider === 'claude' && (
              <>
                <div className="sheet-sub">Nachdenken</div>
                <div className="seg">
                  {EFFORTS.map((e) => (
                    <button
                      key={e}
                      className={tab.effort === e ? 'on' : ''}
                      disabled={busy}
                      onClick={() => api.setEffort(tab.id, e).catch((err) => setError(err.message))}
                    >
                      {EFFORT[e]}
                    </button>
                  ))}
                </div>
              </>
            )}
            {pick !== tab.modelId && (
              <button className="copy-btn primary sheet-apply" disabled={busy || !pick} onClick={applyModel}>
                {busy ? 'Arbeitet gerade, gleich' : !pick ? 'Standard gilt beim nächsten Chat' : provider === 'agy' ? 'Wechseln (startet kurz neu)' : 'Wechseln'}
              </button>
            )}

            <div className="sheet-head">
              <span>Modus</span>
            </div>
            <div className="seg modes">
              {MODES.map((m) => (
                <button key={m.id} className={m.id === tab.mode ? 'on' : ''} disabled={modeBusy} onClick={() => setMode(m.id)}>
                  <m.icon size={15} />
                  <span>{MODE_SHORT[m.id] ?? m.label}</span>
                </button>
              ))}
            </div>
            {mode?.hint && <div className="sheet-hint">{mode.hint}</div>}
            {error && <div className="mode-error">{error}</div>}
          </div>
        </>
      )}
    </>
  );
}
