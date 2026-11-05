export interface DiffRow {
  t: '+' | '-' | ' ';
  text: string;
}

/** Line diff of two snippets (an Edit's old and new text). LCS, fine for the sizes edits have. */
export function lineDiff(before: string, after: string): DiffRow[] {
  // An empty text has no lines (a new file adds lines, it doesn't replace an empty one).
  const a = before ? before.replace(/\r\n/g, '\n').split('\n') : [];
  const b = after ? after.replace(/\r\n/g, '\n').split('\n') : [];
  if (a.length * b.length > 400_000) {
    // Very large: show as replaced block.
    return [...a.map((text) => ({ t: '-' as const, text })), ...b.map((text) => ({ t: '+' as const, text }))];
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: ' ', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) rows.push({ t: '-', text: a[i++] });
    else rows.push({ t: '+', text: b[j++] });
  }
  while (i < n) rows.push({ t: '-', text: a[i++] });
  while (j < m) rows.push({ t: '+', text: b[j++] });
  return rows;
}

/** Keeps changed lines plus a little context; long unchanged stretches are folded. */
export function withContext(rows: DiffRow[], context = 3): (DiffRow | { t: 'gap'; count: number })[] {
  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.t !== ' ') for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const out: (DiffRow | { t: 'gap'; count: number })[] = [];
  let gap = 0;
  rows.forEach((r, i) => {
    if (keep[i]) {
      if (gap) out.push({ t: 'gap', count: gap });
      gap = 0;
      out.push(r);
    } else gap++;
  });
  if (gap) out.push({ t: 'gap', count: gap });
  return out;
}
