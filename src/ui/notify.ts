// Toasts, context menus and native dialogs.
import { ask, message } from "@tauri-apps/plugin-dialog";
import { h } from "../core/util";

let toastHost: HTMLElement | null = null;

export function notify(text: string, kind: "info" | "error" | "warning" = "info", timeout = 4500) {
  toastHost ??= document.getElementById("overlay-root")!.appendChild(h("div.toasts"));
  const el = h("div.toast", { className: `toast toast-${kind}` }, h("span", null, text));
  const close = () => el.remove();
  el.append(h("button.icon-btn", { onclick: close, html: "&times;", title: "Dismiss" }));
  toastHost.append(el);
  if (timeout > 0) setTimeout(close, kind === "error" ? timeout * 2 : timeout);
}

export interface MenuItem {
  label?: string;
  action?: () => unknown;
  keybinding?: string;
  separator?: boolean;
  disabled?: boolean;
}

let openMenu: HTMLElement | null = null;

export function closeContextMenu() {
  openMenu?.remove();
  openMenu = null;
}

export function contextMenu(x: number, y: number, items: MenuItem[]) {
  closeContextMenu();
  const menu = h("div.context-menu");
  for (const item of items) {
    if (item.separator) {
      menu.append(h("div.menu-sep"));
      continue;
    }
    menu.append(
      h(
        "div.menu-item",
        {
          className: `menu-item${item.disabled ? " disabled" : ""}`,
          onmousedown: (e: MouseEvent) => e.preventDefault(),
          onclick: () => {
            closeContextMenu();
            if (!item.disabled) void item.action?.();
          },
        },
        h("span", null, item.label ?? ""),
        h("span.menu-key", null, item.keybinding ?? ""),
      ),
    );
  }
  document.getElementById("overlay-root")!.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - rect.width - 4)}px`;
  menu.style.top = `${Math.min(y, innerHeight - rect.height - 4)}px`;
  openMenu = menu;
}

window.addEventListener("mousedown", (e) => {
  if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu();
});
window.addEventListener("blur", closeContextMenu);
window.addEventListener("keydown", (e) => e.key === "Escape" && closeContextMenu());

export const confirmDialog = (text: string, title = "Sumi") => ask(text, { title, kind: "warning" });

/** Save / Don't Save / Cancel prompt for unsaved files. */
export async function askSave(name: string): Promise<"save" | "discard" | "cancel"> {
  const r = await message(`Do you want to save the changes you made to ${name}?\n\nYour changes will be lost if you don't save them.`, {
    title: "Sumi",
    kind: "warning",
    buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
  });
  if (r === "Save" || r === "Yes") return "save";
  if (r === "Don't Save" || r === "No") return "discard";
  return "cancel";
}
