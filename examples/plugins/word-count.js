// Example Sumi plugin. Copy to ~/.config/sumi/plugins/word-count.js (single-file plugin),
// or put it in a folder with a sumi-plugin.toml manifest. Plugins export `activate(sumi)`.
// Disable with `[plugins] disabled = ["word-count"]`. Reload the window (F5) after changes.

export function activate(sumi) {
  // A status bar item that counts words in the selection (or the whole file).
  const item = sumi.ui.statusBarItem({ align: "right", priority: 5 });

  function update() {
    const editor = sumi.editor.active();
    const model = editor?.getModel();
    if (!model) return item.hide();
    const sel = editor.getSelection();
    const text = sel && !sel.isEmpty() ? model.getValueInRange(sel) : model.getValue();
    const words = (text.match(/\S+/g) || []).length;
    item.show(`${words} words`);
  }
  sumi.editor.onDidChangeActive(update);
  sumi.editor.onDidChangeCursor(update);
  update();

  // A command (shows up in the Command Palette) with its own key binding.
  sumi.commands.register("wordCount.insertDate", "Insert Current Date", () => {
    const editor = sumi.editor.active();
    if (!editor) return;
    editor.executeEdits("word-count", [
      { range: editor.getSelection(), text: new Date().toISOString().slice(0, 10) },
    ]);
  });
  sumi.keybindings.add({ key: "mod+alt+d", command: "wordCount.insertDate" });

  // Plugins can run any program, like herdr plugins. Here: show the git author of HEAD.
  sumi.commands.register("wordCount.lastCommit", "Show Last Commit Author", async () => {
    const root = sumi.workspace.root();
    if (!root) return;
    const r = await sumi.exec(["git", "log", "-1", "--format=%an: %s"], { cwd: root });
    sumi.ui.notify(r.stdout.trim() || r.stderr.trim());
  });
}
