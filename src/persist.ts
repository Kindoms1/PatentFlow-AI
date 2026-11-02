/**
 * 工作区持久化：IndexedDB 为主（容量大，资料和长文稿不会撑爆），localStorage 只做兜底。
 */
const DB_NAME = "patentflow";
const STORE = "kv";
let opening: Promise<IDBDatabase> | null = null;

export function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB 打开失败"));
      request.onblocked = () => reject(new Error("IndexedDB 被其他窗口占用"));
    });
    opening.catch(() => {
      opening = null;
    });
  }
  return opening;
}

export async function kvGet(key: string): Promise<string | undefined> {
  const db = await openDb();
  return new Promise<string | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    request.onsuccess = () => resolve(typeof request.result === "string" ? request.result : undefined);
    request.onerror = () => reject(request.error ?? new Error("读取失败"));
  });
}

export async function kvSet(key: string, value: string): Promise<void> {
  const db = await openDb();
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("写入被中止"));
  });
}
