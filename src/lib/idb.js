// Minimal promise wrapper around IndexedDB — used for autosave snapshots,
// which regularly exceed the localStorage size limit.

const DB_NAME = 'theprototype';
const STORE = 'snapshots';

/** @returns {Promise<IDBDatabase>} */
function open() {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(STORE);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** @param {string} key */
export async function idbGet(key) {
	const db = await open();
	return new Promise((resolve, reject) => {
		const request = db.transaction(STORE).objectStore(STORE).get(key);
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

/** @param {string} key @param {any} value */
export async function idbPut(key, value) {
	const db = await open();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).put(value, key);
		tx.oncomplete = () => resolve(undefined);
		tx.onerror = () => reject(tx.error);
	});
}

/** @param {string} key */
export async function idbDelete(key) {
	const db = await open();
	return new Promise((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).delete(key);
		tx.oncomplete = () => resolve(undefined);
		tx.onerror = () => reject(tx.error);
	});
}
