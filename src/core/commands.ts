// Command registry. Everything a key, menu, palette entry or plugin can trigger is a command.
import type { Disposable } from "./util";

export interface Command {
  id: string;
  title: string;
  run: (...args: any[]) => unknown;
  /** Hidden commands work with keys but are not listed in the palette. */
  hidden?: boolean;
}

const registry = new Map<string, Command>();
let fallback: ((id: string, args: unknown) => boolean) | null = null;

export function registerCommand(id: string, title: string, run: Command["run"], hidden = false): Disposable {
  registry.set(id, { id, title, run, hidden });
  return { dispose: () => registry.delete(id) };
}

/** Called for ids not in the registry, used to route to Monaco editor actions. */
export function setCommandFallback(fn: typeof fallback) {
  fallback = fn;
}

export async function executeCommand(id: string, ...args: unknown[]): Promise<unknown> {
  const cmd = registry.get(id);
  if (cmd) {
    try {
      return await cmd.run(...args);
    } catch (e) {
      console.error(`command ${id} failed`, e);
      const { notify } = await import("../ui/notify");
      notify(`${cmd.title}: ${e instanceof Error ? e.message : e}`, "error");
      return;
    }
  }
  if (!fallback?.(id, args[0])) console.warn(`unknown command: ${id}`);
}

export const allCommands = () => [...registry.values()].filter((c) => !c.hidden);
export const getCommand = (id: string) => registry.get(id);
