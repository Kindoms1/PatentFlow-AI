import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, ReactNode } from "react";
import { DOCK_WIDTH_KEY, normalizeWorkspace, reduce, seed } from "./model.ts";
import type { Action, Persisted, View } from "./model.ts";
import { hasIndexedDb, kvGet, kvSet } from "./persist.ts";

const STORAGE = "patentflow.workspace.v1";
const SAVE_DELAY = 400;

interface StoreValue {
  state: Persisted;
  view: View;
  dispatch: Dispatch<Action>;
  setView: (view: View) => void;
  dockWidth: number;
  setDockWidth: (width: number) => void;
  toast: string | null;
  notify: (message: string) => void;
}

const StoreContext = createContext<StoreValue | null>(null);

function parseWorkspace(raw: string | null | undefined): Persisted | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Persisted;
    if (parsed.schema !== 1 || !Array.isArray(parsed.cases)) return null;
    if (parsed.model) {
      parsed.model.secret = "";
      if (parsed.model.keyHint?.includes("浏览器")) parsed.model.keyHint = "密钥只保存在服务端";
    }
    return normalizeWorkspace(parsed);
  } catch {
    return null;
  }
}

function loadLocal(): Persisted {
  try {
    return parseWorkspace(localStorage.getItem(STORAGE)) ?? seed();
  } catch {
    return seed();
  }
}

/** Save to IndexedDB and mirror to localStorage when it fits. True when at least one store kept the data. */
async function saveWorkspace(state: Persisted): Promise<boolean> {
  const raw = JSON.stringify(state);
  let kept = false;
  if (hasIndexedDb()) {
    try {
      await kvSet(STORAGE, raw);
      kept = true;
    } catch {
      kept = false;
    }
  }
  try {
    localStorage.setItem(STORAGE, raw);
    kept = true;
  } catch {
    // Over the ~5 MB quota: drop the stale mirror so the next start reads the IndexedDB copy.
    try {
      localStorage.removeItem(STORAGE);
    } catch {
      // Storage unavailable (private window); nothing else to do.
    }
  }
  return kept;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Persisted>(loadLocal);
  const [view, setView] = useState<View>("workbench");
  const [dockWidth, setDockWidthState] = useState(() => {
    const saved = Number(localStorage.getItem(DOCK_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 320 && saved <= 680 ? saved : 460;
  });
  const [toast, setToast] = useState<string | null>(null);
  const hydrated = useRef(!hasIndexedDb());
  const latest = useRef(state);
  const warned = useRef(false);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => (current === message ? null : current)), 2800);
  }, []);

  // Load the IndexedDB copy once; on the first run after upgrading, move the localStorage data into it.
  useEffect(() => {
    if (hydrated.current) return;
    let alive = true;
    kvGet(STORAGE)
      .then((raw) => {
        if (!alive) return;
        const stored = parseWorkspace(raw);
        hydrated.current = true;
        if (stored) setState(stored);
        else void saveWorkspace(latest.current);
      })
      .catch(() => {
        hydrated.current = true;
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    latest.current = state;
    if (!hydrated.current) return;
    const timer = window.setTimeout(() => {
      void saveWorkspace(state).then((kept) => {
        if (!kept && !warned.current) {
          warned.current = true;
          notify("浏览器存储空间不足，最新改动可能没有保存。请删除不需要的会话或资料。");
        }
      });
    }, SAVE_DELAY);
    return () => window.clearTimeout(timer);
  }, [state, notify]);

  // Flush the newest state when the tab is closed before the debounce fires.
  useEffect(() => {
    const flush = () => {
      if (!hydrated.current) return;
      const raw = JSON.stringify(latest.current);
      try {
        localStorage.setItem(STORAGE, raw);
      } catch {
        // The IndexedDB write below still runs.
      }
      if (hasIndexedDb()) void kvSet(STORAGE, raw).catch(() => undefined);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const dispatch: Dispatch<Action> = useCallback((action) => {
    setState((current) => reduce(current, action));
    if (action.type === "open-case" || action.type === "restore-demo") setView("case");
    if (action.type === "wipe") setView("workbench");
    if (action.type === "navigate" && action.view) setView(action.view);
  }, []);

  const setDockWidth = useCallback((width: number) => {
    const next = Math.min(680, Math.max(320, width));
    setDockWidthState(next);
    localStorage.setItem(DOCK_WIDTH_KEY, String(next));
  }, []);

  const value = useMemo(
    () => ({ state, view, dispatch, setView, dockWidth, setDockWidth, toast, notify }),
    [state, view, dispatch, dockWidth, setDockWidth, toast, notify],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const value = useContext(StoreContext);
  if (!value) throw new Error("Store missing");
  return value;
}
