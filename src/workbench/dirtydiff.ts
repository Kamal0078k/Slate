// Gutter markers for lines changed since the git index (green = added, blue = modified,
// red = deleted), like VS Code's "quick diff".

export interface Hunk {
  kind: "added" | "modified" | "deleted";
  /** 1-based line range in the current file (for "deleted": the line after the deletion). */
  start: number;
  end: number;
}

/** Myers diff on lines. Returns null if the files differ too much to be worth marking. */
export function diffLines(a: string[], b: string[], maxEdits = 2000): Hunk[] | null {
  // Common prefix/suffix are trimmed first; most edits touch a small region.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const N = A.length;
  const M = B.length;

  const matches: [number, number][] = [];
  if (N && M) {
    const max = Math.min(N + M, maxEdits);
    const off = max + 1;
    const v = new Int32Array(2 * max + 3);
    const trace: Int32Array[] = [];
    let found = false;
    outer: for (let d = 0; d <= max; d++) {
      trace.push(v.slice(off - d - 1, off + d + 2));
      for (let k = -d; k <= d; k += 2) {
        let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
        let y = x - k;
        while (x < N && y < M && A[x] === B[y]) {
          x++;
          y++;
        }
        v[off + k] = x;
        if (x >= N && y >= M) {
          found = true;
          break outer;
        }
      }
    }
    if (!found) return null;
    let x = N;
    let y = M;
    for (let d = trace.length - 1; d >= 0; d--) {
      const t = trace[d];
      const at = (k: number) => t[k + d + 1];
      const k = x - y;
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      const prevX = d === 0 ? 0 : at(prevK);
      const prevY = d === 0 ? 0 : prevX - prevK;
      while (x > prevX && y > prevY) {
        matches.push([x - 1, y - 1]);
        x--;
        y--;
      }
      x = prevX;
      y = prevY;
    }
    matches.reverse();
  }

  const hunks: Hunk[] = [];
  let ai = 0;
  let bi = 0;
  const flush = (aEnd: number, bEnd: number) => {
    const removed = aEnd - ai;
    const added = bEnd - bi;
    if (!removed && !added) return;
    const start = pre + bi + 1;
    if (!removed) hunks.push({ kind: "added", start, end: start + added - 1 });
    else if (!added) hunks.push({ kind: "deleted", start, end: start });
    else hunks.push({ kind: "modified", start, end: start + added - 1 });
  };
  for (const [ma, mb] of matches) {
    flush(ma, mb);
    ai = ma + 1;
    bi = mb + 1;
  }
  flush(N, M);
  return hunks;
}
