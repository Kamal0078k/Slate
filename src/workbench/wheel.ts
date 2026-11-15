// Editor wheel/trackpad scrolling, coalesced per frame with exact fractional positions.
//
// Monaco moves the editor once per wheel event and rounds each move *up* to a whole pixel.
// WebKit delivers trackpad scrolling as many tiny events (up to ~250/s, e.g. wheelDeltaY 3 =
// 1.25 px), so slow swipes were inflated (1.25 px -> 2 px, +60%) and uneven, while fast ones
// were fine. Here each editor collects the wheel deltas of a frame, keeps the exact total
// (remainders carry over), and scrolls once per frame. The speed formula is Monaco's/VS Code's
// own: wheelDeltaY / 120 * 50 px * mouseWheelScrollSensitivity (x fastScrollSensitivity with ⌥).
// Configured by [ui] editor_wheel = "slate" (default) | "monaco".
import { monaco } from "../core/monaco";
import { settings } from "../core/settings";

type Editor = monaco.editor.ICodeEditor;

const editors = new Set<Editor>();
const SCROLL_WHEEL_SENSITIVITY = 50; // Monaco/VS Code px per wheel "line"

interface Pending {
  dx: number;
  dy: number;
  // exact (fractional) position we are driving, and the integer we last applied
  exactTop: number;
  exactLeft: number;
  appliedTop: number;
  appliedLeft: number;
  frame: number;
}
const pending = new WeakMap<Editor, Pending>();

/** Lets the wheel handler drive this editor (call for every editor and diff side). */
export function registerWheelEditor(ed: Editor) {
  // getDomNode() is null until a model is attached; the container exists from creation.
  editors.add(ed);
  ed.onDidDispose(() => editors.delete(ed));
}

/** The editor whose container holds `target` (the innermost, e.g. one side of a diff). */
function editorFor(target: Node | null): Editor | undefined {
  let best: Editor | undefined;
  let bestDepth = -1;
  for (const ed of editors) {
    const box = ed.getContainerDomNode();
    if (!target || !box.contains(target)) continue;
    let depth = 0;
    for (let n: Node | null = box; n; n = n.parentNode) depth++;
    if (depth > bestDepth) {
      best = ed;
      bestDepth = depth;
    }
  }
  return best;
}

function flush(ed: Editor, p: Pending) {
  p.frame = 0;
  // If something else scrolled the editor (keyboard, reveal, scrollbar drag), start from there.
  if (ed.getScrollTop() !== p.appliedTop) p.exactTop = ed.getScrollTop();
  if (ed.getScrollLeft() !== p.appliedLeft) p.exactLeft = ed.getScrollLeft();
  const maxTop = Math.max(0, ed.getScrollHeight() - ed.getLayoutInfo().height);
  const maxLeft = Math.max(0, ed.getScrollWidth() - ed.getLayoutInfo().width);
  p.exactTop = Math.min(maxTop, Math.max(0, p.exactTop + p.dy));
  p.exactLeft = Math.min(maxLeft, Math.max(0, p.exactLeft + p.dx));
  p.dx = p.dy = 0;
  const top = Math.round(p.exactTop);
  const left = Math.round(p.exactLeft);
  if (top !== ed.getScrollTop() || left !== ed.getScrollLeft()) ed.setScrollPosition({ scrollTop: top, scrollLeft: left }, monaco.editor.ScrollType.Immediate);
  p.appliedTop = top;
  p.appliedLeft = left;
}

function onWheel(e: WheelEvent) {
  if (settings.get("ui.editor_wheel", "slate") !== "slate" || e.ctrlKey) return; // ctrl+wheel = zoom gestures
  const ed = editorFor(e.target as Node | null);
  if (!ed || !ed.getModel()) return;
  // Same normalization as Monaco's StandardWheelEvent (legacy wheelDelta when present).
  const legacy = e as unknown as { wheelDeltaY?: number; wheelDeltaX?: number };
  let ny = typeof legacy.wheelDeltaY === "number" ? legacy.wheelDeltaY / 120 : e.deltaMode === 1 ? -e.deltaY : -e.deltaY / 40;
  let nx = typeof legacy.wheelDeltaX === "number" ? legacy.wheelDeltaX / 120 : e.deltaMode === 1 ? -e.deltaX : -e.deltaX / 40;
  if (!ny && !nx) return;
  // Scroll along the dominant axis only (Monaco's scrollPredominantAxis default).
  if (Math.abs(ny) >= Math.abs(nx)) nx = 0;
  else ny = 0;
  let factor = ed.getOption(monaco.editor.EditorOption.mouseWheelScrollSensitivity) * SCROLL_WHEEL_SENSITIVITY;
  if (e.altKey) factor *= ed.getOption(monaco.editor.EditorOption.fastScrollSensitivity);
  const atTop = ed.getScrollTop() <= 0 && ny > 0;
  const maxTop = Math.max(0, ed.getScrollHeight() - ed.getLayoutInfo().height);
  const atBottom = ed.getScrollTop() >= maxTop && ny < 0;
  if ((atTop || atBottom) && !nx) return; // let the page/rubber band have it, like Monaco
  e.preventDefault();
  e.stopPropagation();
  let p = pending.get(ed);
  if (!p) {
    p = { dx: 0, dy: 0, exactTop: ed.getScrollTop(), exactLeft: ed.getScrollLeft(), appliedTop: ed.getScrollTop(), appliedLeft: ed.getScrollLeft(), frame: 0 };
    pending.set(ed, p);
  }
  p.dy -= ny * factor;
  p.dx -= nx * factor;
  if (!p.frame) {
    const target = p;
    target.frame = requestAnimationFrame(() => flush(ed, target));
  }
}

/** Installs the handler once; it runs before Monaco's own (capture phase on the window). */
export function installEditorWheel() {
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
}
