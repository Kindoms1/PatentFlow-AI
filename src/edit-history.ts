/**
 * A small undo/redo history for the chat composer.
 *
 * React rewrites the textarea value on every render, and the app also replaces it programmatically
 * (sending clears it, hint buttons and the skill menu fill it). Browsers drop their native undo stack
 * on programmatic changes, so Ctrl+Z could not bring back a deleted question. The composer keeps its
 * own history instead: quick single-character typing is grouped into one step, while a pause, a paste,
 * a multi-character delete or a programmatic change starts a new step.
 */
export interface EditHistory {
  stack: string[];
  index: number;
  lastAt: number;
}

export const HISTORY_LIMIT = 200;
export const GROUP_MS = 800;

export function createHistory(initial = ""): EditHistory {
  return { stack: [initial], index: 0, lastAt: 0 };
}

export function recordEdit(history: EditHistory, next: string, now: number): EditHistory {
  const prev = history.stack[history.index];
  if (prev === next) return history;
  const base = history.stack.slice(0, history.index + 1);
  const small = prev !== "" && next !== "" && Math.abs(next.length - prev.length) <= 1;
  const mergeable = small && history.index > 0 && history.lastAt > 0 && now - history.lastAt < GROUP_MS;
  if (mergeable) {
    base[history.index] = next;
    return { stack: base, index: history.index, lastAt: now };
  }
  base.push(next);
  while (base.length > HISTORY_LIMIT) base.shift();
  return { stack: base, index: base.length - 1, lastAt: now };
}

export function undoEdit(history: EditHistory): { history: EditHistory; value: string } | null {
  if (history.index === 0) return null;
  const index = history.index - 1;
  return { history: { stack: history.stack, index, lastAt: 0 }, value: history.stack[index] };
}

export function redoEdit(history: EditHistory): { history: EditHistory; value: string } | null {
  if (history.index >= history.stack.length - 1) return null;
  const index = history.index + 1;
  return { history: { stack: history.stack, index, lastAt: 0 }, value: history.stack[index] };
}