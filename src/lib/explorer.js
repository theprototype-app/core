// @ts-ignore - no bundled three type declarations (project-wide)
import * as THREE from 'three';
import { writable, get } from 'svelte/store';
// @ts-ignore - see above
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
// @ts-ignore - see above
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
// @ts-ignore - see above
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
// @ts-ignore - see above
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { idbGet, idbPut, idbDelete } from './idb';
import { showToast } from '../stores/appStore';

// Explorer (phase 95): a LOCAL asset library (like prefabs — nothing here
// replicates until an asset is USED). Folder tree + items live as one small
// index record in IndexedDB; the raw file bytes live as one blob record per
// item so the in-memory store only carries metadata + small thumbnails.

const INDEX_KEY = 'explorer:index';
const BLOB_KEY = 'explorer:blob:';
export const MAX_ITEM_BYTES = 25 * 1024 * 1024;

/** @type {import('svelte/store').Writable<{id: string, name: string, parentId: string | null}[]>} */
export const explorerFolders = writable([]);
/** @type {import('svelte/store').Writable<{id: string, name: string, kind: string, folderId: string | null, size: number, hash: string, thumbnail: string | null, createdAt: number}[]>} */
export const explorerItems = writable([]);
/** selected folder id, null = library root, 'prefabs' = the virtual prefab folder */
/** @type {import('svelte/store').Writable<string | null>} */
export const activeFolder = writable(null);

const EXTENSIONS = {
	image: ['png', 'jpg', 'jpeg', 'webp', 'gif'],
	audio: ['mp3', 'wav', 'ogg'],
	text: ['txt', 'json', 'md', 'cfg', 'js'],
	object: ['glb', 'gltf', 'obj', 'stl', 'fbx']
};

/** @param {string} name */
export function kindOf(name) {
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	for (const [kind, exts] of Object.entries(EXTENSIONS)) if (exts.includes(ext)) return kind;
	return null;
}

let loaded = false;
export async function loadExplorer() {
	if (loaded || typeof indexedDB === 'undefined') return;
	loaded = true;
	try {
		const index = (await idbGet(INDEX_KEY)) ?? { folders: [], items: [] };
		explorerFolders.set(index.folders ?? []);
		explorerItems.set(index.items ?? []);
	} catch (error) {
		console.log('explorer load failed', error);
	}
}

async function persistIndex() {
	try {
		await idbPut(INDEX_KEY, { folders: get(explorerFolders), items: get(explorerItems) });
	} catch (error) {
		console.log('explorer persist failed', error);
	}
}

// ---- folders ----

/** Folder names can't carry `* \ /` (106) @param {string} name */
export function isValidName(name) {
	return !!name?.trim() && !/[*\\/]/.test(name);
}

/** @param {string} name @param {string | null=} parentId */
export function createFolder(name, parentId = null) {
	if (!isValidName(name)) return null;
	const folder = { id: crypto.randomUUID(), name: name.trim(), parentId };
	explorerFolders.update((list) => [...list, folder]);
	persistIndex();
	return folder;
}

/** @param {string} id @param {string} name */
export function renameFolder(id, name) {
	if (!isValidName(name)) return false;
	explorerFolders.update((list) => list.map((f) => (f.id === id ? { ...f, name: name.trim() } : f)));
	persistIndex();
	return true;
}

/** Every folder id inside a subtree, root included @param {string} id */
export function folderSubtree(id) {
	const list = get(explorerFolders);
	const out = [id];
	for (let i = 0; i < out.length; i++)
		for (const f of list) if (f.parentId === out[i]) out.push(f.id);
	return out;
}

/** What a cascade delete would remove (for the confirm, 106) @param {string} id */
export function folderCounts(id) {
	const subtree = folderSubtree(id);
	const items = get(explorerItems).filter((item) => subtree.includes(item.folderId ?? ''));
	return { folders: subtree.length, items: items.length };
}

/** Cascade delete (106): the folder, its subfolders AND their items @param {string} id */
export async function deleteFolder(id) {
	const subtree = folderSubtree(id);
	const doomed = get(explorerItems).filter((item) => subtree.includes(item.folderId ?? ''));
	explorerFolders.update((list) => list.filter((f) => !subtree.includes(f.id)));
	explorerItems.update((list) => list.filter((item) => !subtree.includes(item.folderId ?? '')));
	activeFolder.update((current) => (current && subtree.includes(current) ? null : current));
	for (const item of doomed) await idbDelete(BLOB_KEY + item.id);
	await persistIndex();
}

/** Re-parent a folder by drag (106); refuses cycles @param {string} id @param {string | null} parentId */
export function moveFolder(id, parentId) {
	if (id === parentId) return false;
	if (parentId && folderSubtree(id).includes(parentId)) return false; // no cycles
	explorerFolders.update((list) =>
		list.map((f) => (f.id === id ? { ...f, parentId } : f))
	);
	persistIndex();
	return true;
}

/** @param {string} itemId @param {string | null} folderId */
export function moveItem(itemId, folderId) {
	explorerItems.update((list) =>
		list.map((item) => (item.id === itemId ? { ...item, folderId } : item))
	);
	persistIndex();
}

// ---- items ----

/** @param {ArrayBuffer} buffer */
async function sha256(buffer) {
	const digest = await crypto.subtle.digest('SHA-256', buffer);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** offscreen render shared by every 3D kind (prefabs pattern) @param {any} object */
function renderObjectThumbnail(object) {
	try {
		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
		renderer.setSize(128, 128);
		const scene = new THREE.Scene();
		scene.add(new THREE.HemisphereLight(0xffffff, 0x444466, 2.4));
		scene.add(object);
		const box = new THREE.Box3().setFromObject(object);
		if (!isFinite(box.min.x)) return null;
		const size = Math.max(box.getSize(new THREE.Vector3()).length(), 0.001);
		const center = box.getCenter(new THREE.Vector3());
		const camera = new THREE.PerspectiveCamera(40, 1, size / 100, size * 10);
		camera.position.copy(center).add(new THREE.Vector3(size * 0.7, size * 0.55, size * 0.9));
		camera.lookAt(center);
		renderer.render(scene, camera);
		const url = renderer.domElement.toDataURL('image/webp', 0.72);
		renderer.dispose();
		renderer.forceContextLoss?.();
		return url;
	} catch (error) {
		console.log('explorer thumbnail failed', error);
		return null;
	}
}

/** @param {Blob} blob */
function imageThumbnail(blob) {
	return new Promise((resolve) => {
		const img = new Image();
		const url = URL.createObjectURL(blob);
		img.onload = () => {
			const scale = Math.min(1, 128 / Math.max(img.width, img.height));
			const canvas = document.createElement('canvas');
			canvas.width = Math.max(1, Math.round(img.width * scale));
			canvas.height = Math.max(1, Math.round(img.height * scale));
			canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
			URL.revokeObjectURL(url);
			resolve(canvas.toDataURL('image/webp', 0.75));
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			resolve(null);
		};
		img.src = url;
	});
}

/** Parse a 3D file into a THREE object (thumbnail + N4 preview) @param {ArrayBuffer} buffer @param {string} ext */
export async function parseObjectFile(buffer, ext) {
	if (ext === 'obj') return new OBJLoader().parse(new TextDecoder().decode(buffer));
	if (ext === 'stl') {
		const geometry = new STLLoader().parse(buffer);
		return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8899aa }));
	}
	if (ext === 'fbx') return new FBXLoader().parse(buffer, '');
	// glb/gltf
	const gltf = await new Promise((resolve, reject) =>
		new GLTFLoader().parse(buffer, '', resolve, reject)
	);
	return gltf.scene;
}

/** @param {Blob} blob @param {string} name @param {string} kind */
async function thumbnailFor(blob, name, kind) {
	try {
		if (kind === 'image') return await imageThumbnail(blob);
		if (kind === 'object') {
			const ext = name.split('.').pop()?.toLowerCase() ?? '';
			const object = await parseObjectFile(await blob.arrayBuffer(), ext);
			return renderObjectThumbnail(object);
		}
	} catch (error) {
		console.log('thumbnail skipped for ' + name, error);
	}
	return null; // audio/text get icon cards
}

/**
 * Import dropped/picked files into a folder. Returns the created items.
 * @param {FileList | File[]} files @param {string | null} folderId
 */
export async function importFiles(files, folderId = null) {
	const created = [];
	for (const file of [...files]) {
		const kind = kindOf(file.name);
		if (!kind) {
			showToast('Unsupported: ' + file.name + ' (images, audio, text/config, 3D objects)');
			continue;
		}
		if (file.size > MAX_ITEM_BYTES) {
			showToast(file.name + ' is over the 25 MB Explorer limit');
			continue;
		}
		const buffer = await file.arrayBuffer();
		const blob = new Blob([buffer], { type: file.type });
		const item = {
			id: crypto.randomUUID(),
			name: file.name,
			kind,
			folderId: folderId === 'prefabs' ? null : folderId,
			size: file.size,
			hash: await sha256(buffer),
			thumbnail: await thumbnailFor(blob, file.name, kind),
			createdAt: Date.now()
		};
		await idbPut(BLOB_KEY + item.id, blob);
		explorerItems.update((list) => [...list, item]);
		created.push(item);
	}
	if (created.length) {
		await persistIndex();
		showToast('Imported ' + created.length + ' item' + (created.length === 1 ? '' : 's'));
	}
	return created;
}

/**
 * Add raw bytes programmatically (97 shared sounds land here). Dedupes by
 * content hash. @param {ArrayBuffer} buffer @param {string} name
 * @param {string | null} folderId
 */
export async function addItemFromBytes(buffer, name, folderId = null) {
	const hash = await sha256(buffer);
	const existing = get(explorerItems).find((item) => item.hash === hash);
	if (existing) return existing;
	const kind = kindOf(name) ?? 'text';
	const blob = new Blob([buffer]);
	// the thumbnail is DECORATIVE — never let a wedged loader/renderer block
	// storing the bytes (a hung GLB parse used to silently swallow shared
	// assets on the receiving peer, R-3); the card falls back to an icon
	const thumbnail = await Promise.race([
		thumbnailFor(blob, name, kind),
		new Promise((resolve) => setTimeout(() => resolve(null), 4000))
	]);
	const item = {
		id: crypto.randomUUID(),
		name,
		kind,
		folderId,
		size: buffer.byteLength,
		hash,
		thumbnail,
		createdAt: Date.now()
	};
	await idbPut(BLOB_KEY + item.id, blob);
	explorerItems.update((list) => [...list, item]);
	await persistIndex();
	return item;
}

/** @param {string} id */
export async function deleteItem(id) {
	explorerItems.update((list) => list.filter((item) => item.id !== id));
	await idbDelete(BLOB_KEY + id);
	await persistIndex();
}

/** @param {string} id @param {string} name */
export function renameItem(id, name) {
	explorerItems.update((list) => list.map((item) => (item.id === id ? { ...item, name } : item)));
	persistIndex();
}

/** the item whose properties show in the Inspector (107) */
/** @type {import('svelte/store').Writable<string | null>} */
export const inspectedFile = writable(null);

/** Save edited text back into an item — hash + size recompute (107)
 * @param {string} id @param {string} text */
export async function updateItemBytes(id, text) {
	const buffer = new TextEncoder().encode(text).buffer;
	const hash = await sha256(buffer);
	await idbPut(BLOB_KEY + id, new Blob([buffer], { type: 'text/plain' }));
	explorerItems.update((list) =>
		list.map((item) => (item.id === id ? { ...item, hash, size: buffer.byteLength } : item))
	);
	await persistIndex();
}

/** The stored file bytes @param {string} id @returns {Promise<Blob | null>} */
export function itemBlob(id) {
	return idbGet(BLOB_KEY + id).then((blob) => blob ?? null);
}

/** Find an item by content hash (97 pull path) @param {string} hash */
export function itemByHash(hash) {
	return get(explorerItems).find((item) => item.hash === hash) ?? null;
}
