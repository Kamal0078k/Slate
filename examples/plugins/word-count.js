// Example Slate plugin. Copy to ~/.config/slate/plugins/word-count.js (single-file plugin),
// or put it in a folder with a slate-plugin.toml manifest. Plugins export `activate(slate)`.
// Disable with `[plugins] disabled = ["word-count"]`. Reload the window (F5) after changes.

export function activate(slate) {
  // A status bar item that counts words in the selection (or the whole file).
  const item = slate.ui.statusBarItem({ align: "right", priority: 5 });

  function update() {
    const editor = slate.editor.active();
    const model = editor?.getModel();
    if (!model) return item.hide();
    const sel = editor.getSelection();
    const text = sel && !sel.isEmpty() ? model.getValueInRange(sel) : model.getValue();
    const words = (text.match(/\S+/g) || []).length;
    item.show(`${words} words`);
  }
  slate.editor.onDidChangeActive(update);
  slate.editor.onDidChangeCursor(update);
  update();

  // A command (shows up in the Command Palette) with its own key binding.
  slate.commands.register("wordCount.insertDate", "Insert Current Date", () => {
    const editor = slate.editor.active();
    if (!editor) return;
    editor.executeEdits("word-count", [
      { range: editor.getSelection(), text: new Date().toISOString().slice(0, 10) },
    ]);
  });
  slate.keybindings.add({ key: "mod+alt+d", command: "wordCount.insertDate" });

  // Plugins can run any program, like herdr plugins. Here: show the git author of HEAD.
  slate.commands.register("wordCount.lastCommit", "Show Last Commit Author", async () => {
    const root = slate.workspace.root();
    if (!root) return;
    const r = await slate.exec(["git", "log", "-1", "--format=%an: %s"], { cwd: root });
    slate.ui.notify(r.stdout.trim() || r.stderr.trim());
  });
}
