const DATABASE_NAME = 'moyu.attachment-drafts.v1';
const FILES_STORE = 'files';

let database: Promise<IDBDatabase> | undefined;

function openDraftDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(FILES_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

export async function loadDraftFiles(scope: string): Promise<File[]> {
  const db = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(FILES_STORE).objectStore(FILES_STORE).get(scope);
    request.onsuccess = () => resolve((request.result as File[] | undefined) ?? []);
    request.onerror = () => reject(request.error);
  });
}

async function updateDraftFiles(mutate: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDraftDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(FILES_STORE, 'readwrite');
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
    mutate(transaction.objectStore(FILES_STORE));
  });
}

export function saveDraftFiles(scope: string, files: File[]): Promise<void> {
  return updateDraftFiles((store) => {
    if (files.length) store.put(files, scope);
    else store.delete(scope);
  });
}

export function clearOwnerDraftFiles(ownerId: string): Promise<void> {
  const range = IDBKeyRange.bound(`${ownerId}\u0000`, `${ownerId}\u0001`, false, true);
  return updateDraftFiles((store) => store.delete(range));
}
