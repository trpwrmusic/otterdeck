// One memory for every folder: Claude Code keeps its auto-memory per project
// (<account>/projects/<folder>/memory). Otterdeck links each project's memory folder to the one of
// the home folder, so what Claude learns in one project it knows everywhere.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './config.ts';
import { encodeProjectDir } from './claudeData.ts';

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function isLinkTo(link: string, target: string) {
  try {
    if (!fs.lstatSync(link).isSymbolicLink()) return false;
    return same(fs.realpathSync(link), fs.realpathSync(target));
  } catch {
    return false;
  }
}

/** Moves memories from a project's own folder into the shared one, without overwriting anything. */
function mergeInto(from: string, shared: string, projectName: string) {
  const suffix = projectName.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() || 'projekt';
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    if (!fs.statSync(src).isFile()) continue;
    if (name === 'MEMORY.md') {
      // Index lines the shared index doesn't have yet are appended.
      const index = path.join(shared, 'MEMORY.md');
      const have = fs.existsSync(index) ? fs.readFileSync(index, 'utf8') : '# Memory Index\n';
      const extra = fs
        .readFileSync(src, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim().startsWith('- ') && !have.includes(l.trim()));
      if (extra.length) fs.writeFileSync(index, have.replace(/\s*$/, '\n') + extra.join('\n') + '\n');
      fs.rmSync(src);
      continue;
    }
    let dest = path.join(shared, name);
    if (fs.existsSync(dest)) {
      if (fs.readFileSync(dest).equals(fs.readFileSync(src))) {
        fs.rmSync(src);
        continue;
      }
      const ext = path.extname(name);
      dest = path.join(shared, `${path.basename(name, ext)}-${suffix}${ext}`);
      // Keep the renamed memory findable from the index.
      const index = path.join(shared, 'MEMORY.md');
      const line = `- [${path.basename(name, ext)} (${projectName})](${path.basename(dest)}) — aus ${projectName} übernommen`;
      fs.appendFileSync(index, line + '\n');
    }
    fs.renameSync(src, dest);
  }
}

/** Makes sure Claude in `projectPath` uses the home folder's memory. Never throws. */
export function shareMemory(projectPath: string, accountDir: string) {
  try {
    if (same(projectPath, HOME)) return;
    const shared = path.join(accountDir, 'projects', encodeProjectDir(HOME), 'memory');
    const own = path.join(accountDir, 'projects', encodeProjectDir(projectPath), 'memory');
    fs.mkdirSync(shared, { recursive: true });
    if (isLinkTo(own, shared)) return;
    if (fs.existsSync(own)) {
      if (fs.lstatSync(own).isSymbolicLink()) fs.rmdirSync(own); // a link pointing somewhere else
      else {
        mergeInto(own, shared, path.basename(projectPath));
        if (fs.readdirSync(own).length) return; // something unexpected (subfolders): leave it alone
        fs.rmdirSync(own);
      }
    }
    fs.mkdirSync(path.dirname(own), { recursive: true });
    // A junction needs no admin rights on Windows.
    fs.symlinkSync(shared, own, 'junction');
  } catch (err) {
    console.error('Gemeinsame Erinnerungen konnten nicht verknüpft werden:', projectPath, (err as Error).message);
  }
}
