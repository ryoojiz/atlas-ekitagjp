export type Book = { id: string; name: string; createdAt: string };
export type StoreState = { books: Book[]; entries: Record<string, string[]>; stampScale: number; terrain: boolean };
export const DEFAULT_BOOK = 'default';
const initial = (): StoreState => ({ books: [{ id: DEFAULT_BOOK, name: 'Stamp Book', createdAt: new Date().toISOString() }], entries: {}, stampScale: 100, terrain: false });
const clampScale = (value: number) => Math.max(50, Math.min(200, value));
function scaleFrom(value: { stampScale?: number; stampSize?: number }): number {
  if (Number.isFinite(value.stampScale)) return clampScale(Number(value.stampScale));
  if (Number.isFinite(value.stampSize)) return clampScale(Math.round(Number(value.stampSize) / 92 * 100));
  return 100;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ekitag-atlas', 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('local')) request.result.createObjectStore('local'); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function readState(): Promise<StoreState> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('local', 'readonly');
    const request = tx.objectStore('local').get('state');
    request.onsuccess = () => {
      const saved = request.result as (Partial<StoreState> & { stampSize?: number }) | undefined;
      if (!saved) return resolve(initial());
      const migrated = { ...initial(), ...saved, stampScale: scaleFrom(saved) };
      delete migrated.stampSize;
      resolve(migrated);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
export async function writeState(value: StoreState): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('local', 'readwrite');
    tx.objectStore('local').put(value, 'state');
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
export function validateBackup(input: unknown, ids: Set<string>): StoreState {
  if (!input || typeof input !== 'object') throw new Error('Backup is not an object.');
  const v = input as Partial<StoreState> & { stampSize?: number };
  if (!Array.isArray(v.books) || !v.entries || typeof v.entries !== 'object') throw new Error('Backup has no collections.');
  const books = v.books.filter((b): b is Book => !!b && typeof b.id === 'string' && typeof b.name === 'string' && typeof b.createdAt === 'string');
  if (!books.some(b => b.id === DEFAULT_BOOK)) books.unshift(initial().books[0]);
  const entries: Record<string, string[]> = {};
  for (const b of books) {
    const value = (v.entries as Record<string, unknown>)[b.id];
    entries[b.id] = Array.isArray(value) ? [...new Set(value.filter((x): x is string => typeof x === 'string' && ids.has(x)))] : [];
  }
  return { books, entries, stampScale: scaleFrom(v), terrain: v.terrain === true };
}
export async function cacheSavedImage(url: string): Promise<void> { const cache = await caches.open('saved-art-v1'); await cache.add(url); }
export async function removeSavedImage(url: string): Promise<void> { const cache = await caches.open('saved-art-v1'); await cache.delete(url); }
export async function requestPersistence(): Promise<boolean> { return !!(await navigator.storage?.persist?.()); }
