import hljs from 'highlight.js/lib/common';

const BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', php: 'php', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell', bat: 'dos', cmd: 'dos',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini',
  sql: 'sql', graphql: 'graphql', lua: 'lua', dart: 'dart', r: 'r',
};

export function languageFor(path: string): string | null {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile') return 'makefile';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  const lang = BY_EXT[ext];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** HTML for one line of code. Lines are highlighted one by one, which is good enough for diffs. */
export function highlightLine(text: string, lang: string | null): string {
  if (!lang || text.length > 2000) return escape(text);
  try {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escape(text);
  }
}
