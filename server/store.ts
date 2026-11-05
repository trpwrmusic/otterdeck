import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { TabKind } from '../shared/types.ts';
import { DATA_DIR } from './config.ts';

export interface ProjectRecord {
  id: string;
  path: string;
  name?: string;
  pinned?: boolean;
  /** Name of the group this project belongs to (Heidehof → App, Website). */
  group?: string;
  account?: string;
  /** Own icon file in ICON_DIR (otherwise one found in the folder). */
  icon?: string;
  addedAt: number;
  lastUsed: number;
}

export interface TabRecord {
  id: string;
  projectId: string;
  kind: TabKind;
  claudeSessionId?: string;
  /** Sent as soon as the conversation resumes after a restart ("carry on"). */
  pendingPrompt?: string;
  /** Claude config dir the session belongs to. */
  account?: string;
  createdAt: number;
}

interface Data {
  version: 1;
  projects: ProjectRecord[];
  tabs: TabRecord[];
  /** Set once the old "last used" stamps were reset (see index.ts). */
  activityV2?: boolean;
  /** Icon file (in ICON_DIR) per group name. */
  groupIcons?: Record<string, string>;
}

const FILE = path.join(DATA_DIR, 'state.json');

function load(): Data {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { version: 1, projects: d.projects ?? [], tabs: d.tabs ?? [], activityV2: d.activityV2, groupIcons: d.groupIcons ?? {} };
  } catch {
    return { version: 1, projects: [], tabs: [] };
  }
}

export const data: Data = load();

let timer: NodeJS.Timeout | null = null;
export function save() {
  if (timer) return;
  timer = setTimeout(flush, 300);
}

export function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

export const newId = () => crypto.randomBytes(6).toString('hex');

export const samePath = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
