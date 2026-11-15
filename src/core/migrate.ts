// One-time carry-over from Sumi's former name, Slate: saved state (recent folders and files,
// open tabs, layout sizes, explorer folds, last background) lived under "slate.*" keys.
// Copies each to its "sumi.*" name unless that already exists. Imported first by main.ts,
// before anything reads these keys.
try {
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith("slate.")) continue;
    const next = `sumi.${key.slice("slate.".length)}`;
    const value = localStorage.getItem(key);
    if (value !== null && localStorage.getItem(next) === null) localStorage.setItem(next, value);
  }
} catch {
  /* storage unavailable: nothing to carry over */
}

export {};
