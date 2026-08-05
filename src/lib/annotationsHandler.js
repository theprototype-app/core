import * as THREE from 'three';
import { writable, get } from 'svelte/store';
import { objectsGroup, selectedObject, globalCamera, globalScene } from '../stores/sceneStore';
import { peers, username, showToast } from '../stores/appStore';
import { registerAnnotationsPersistence, markAnnotationsDirty } from './autosave';
import { flyTo } from './objectActions';

// Synced note pins on objects. Offsets are object-local so pins follow their
// object; one note per pin. Replication mirrors the flow-graph pattern:
// live CRUD messages + a full-state reply on the connection handshake.

/** @type {import('svelte/store').Writable<{id: string, objectUuid: string, objectName: string, offset: number[], text: string, author: string, authorKey: string, ts: number, name: string, color: string, label: string, shape: string}[]>} */
export const annotations = writable([]);
/** popover state: { id, mode:'view'|'edit' } for an existing note, { draft: {...} } for a new one, or null */
/** @type {import('svelte/store').Writable<any>} */
export const activeAnnotation = writable(null);
/** the THREE group holding pin meshes, registered by AnnotationPins.svelte */
/** @type {import('svelte/store').Writable<any>} */
export const pinsGroup = writable(null);

/** H3: LOCAL pref — pins visible in the viewport (not replicated) */
export const showNotePins = writable(
	typeof localStorage === 'undefined' || localStorage.getItem('showNotePins') !== 'false'
);
if (typeof localStorage !== 'undefined')
	showNotePins.subscribe((value) => localStorage.setItem('showNotePins', String(value)));

/** H9: pin shapes (replicated per note; 'round' = the historical pin) */
export const NOTE_SHAPES = ['round', 'star', 'square'];

/** H1/H4: the fixed pin palette (amber first = the historical pin color) */
export const NOTE_COLORS = [
	'#f59e0b',
	'#ef4444',
	'#ec4899',
	'#a855f7',
	'#3b82f6',
	'#22d3ee',
	'#22c55e',
	'#a3e635'
];
export const DEFAULT_NOTE_COLOR = NOTE_COLORS[0];

const tempVector = new THREE.Vector3();

/**
 * H1: ONE boundary normalizer. `text` stays the description (replication,
 * autosave, sessions and the e2e suites all carry it); v2 adds optional
 * name/color/label, so payloads from old autosaves, .tpscene sessions and
 * old-version peers load with defaults for free.
 * @param {any} a
 */
export function normalizeAnnotation(a) {
	return {
		...a,
		text: typeof a?.text === 'string' ? a.text : '',
		name: typeof a?.name === 'string' ? a.name : '',
		color: typeof a?.color === 'string' && a.color ? a.color : DEFAULT_NOTE_COLOR,
		label: typeof a?.label === 'string' ? a.label : '',
		shape: NOTE_SHAPES.includes(a?.shape) ? a.shape : 'round',
		// H10: who wrote it — `author` is the DISPLAY name at save time, `authorKey`
		// is the writer's stable device key (only they can match it)
		authorKey: typeof a?.authorKey === 'string' ? a.authorKey : '',
		// H12: fixed NAME of a SCENE-ROOT anchor (env rig / module content). Those
		// objects are rebuilt with fresh uuids every boot, so the uuid alone can't
		// survive a reload — the sweep re-keys by name instead of pruning.
		objectName: typeof a?.objectName === 'string' ? a.objectName : ''
	};
}

// --- H9 color math (sRGB bytes, never through THREE.Color: round-tripping a hex
// through the LINEAR working space re-darkens it — the documented trap) --------

/** @param {string} hex @returns {[number, number, number]} */
function rgbOf(hex) {
	const clean = (hex || '').replace('#', '');
	const full =
		clean.length === 3
			? clean
					.split('')
					.map((c) => c + c)
					.join('')
			: clean;
	const value = parseInt(full || '000000', 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** A darker shade of `hex` — the pin's border ring @param {string} hex @param {number=} factor */
export function shadeHex(hex, factor = 0.55) {
	const [r, g, b] = rgbOf(hex);
	/** @param {number} v */
	const to = (v) => Math.max(0, Math.min(255, Math.round(v * factor)));
	return '#' + [to(r), to(g), to(b)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** `hex` as an rgba() string — an occluded marker fades its FILL, not its text
 * @param {string} hex @param {number} alpha */
export function rgbaOf(hex, alpha) {
	const [r, g, b] = rgbOf(hex);
	return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Readable ink for a pin of this fill color — the classic YIQ brightness split
 * at 0.5 (black on amber/green/lime/cyan, white on blue/red/pink/violet).
 * @param {string} hex
 */
export function contrastOn(hex) {
	const [r, g, b] = rgbOf(hex);
	const brightness = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
	return brightness > 0.5 ? '#1c1917' : '#f8fafc';
}

// --- H10 author identity ------------------------------------------------------

const AUTHOR_KEY = 'noteAuthorKey';
/** @type {string} */
let authorKeyCache = '';

/**
 * A stable per-DEVICE key for "notes I wrote". Peer ids are re-issued on every
 * reconnect and nicknames change, so neither can answer "is this mine?" across a
 * rename or a reload — this can. It rides the note (replicated, meaningless to
 * anyone else) purely so WE can render 'Me' and re-stamp our own display name.
 */
export function myAuthorKey() {
	if (authorKeyCache) return authorKeyCache;
	try {
		const stored = localStorage.getItem(AUTHOR_KEY);
		authorKeyCache = stored || crypto.randomUUID();
		if (!stored) localStorage.setItem(AUTHOR_KEY, authorKeyCache);
	} catch {
		authorKeyCache = 'local';
	}
	return authorKeyCache;
}

/** Our own display name at THIS moment (stored on notes we create) */
export function myAuthorName() {
	/** @type {any} */
	const peer = get(peers);
	return (get(username) || '').trim() || peer?.peer?.id || 'anonymous';
}

/** Legacy identity check for notes with no authorKey @param {string} author */
export function isMyAuthor(author) {
	const value = (author || '').trim();
	if (!value) return false;
	/** @type {any} */
	const peer = get(peers);
	const nickname = (get(username) || '').trim();
	return (!!nickname && value === nickname) || (!!peer?.peer?.id && value === peer.peer.id);
}

/** Did WE write this note? @param {any} a */
export function isMyNote(a) {
	if (!a) return false;
	if (a.authorKey) return a.authorKey === myAuthorKey();
	return isMyAuthor(a.author); // pre-authorKey notes fall back to name/peer-id
}

/**
 * H10: 'Me' is a DISPLAY-only convenience. The stored author is always a real
 * nickname (or peer id), so a saved .tpscene/autosave shows the owner's name to
 * everyone else. @param {any} a
 */
export function displayAuthor(a) {
	const author = (a?.author || '').trim();
	if (!author) return 'peer';
	return isMyNote(a) ? 'Me' : author;
}

/** 1-based GLOBAL index — MUST match the in-scene pin numbering @param {string} id */
export function noteNumber(id) {
	return get(annotations).findIndex((a) => a.id === id) + 1;
}

/** Row/card title: explicit name, else a trimmed description, else "Note n" @param {any} a */
export function displayName(a) {
	if (!a) return '';
	const name = (a.name || '').trim();
	if (name) return name;
	const text = (a.text || '').trim().replace(/\s+/g, ' ');
	if (text) return text.length > 40 ? text.slice(0, 40) + '…' : text;
	const n = noteNumber(a.id);
	return 'Note ' + (n > 0 ? n : '');
}

/** @param {string} uuid */
function objectOf(uuid) {
	// system/environment objects live at the scene root (annotatable per 87)
	return (
		get(objectsGroup)?.getObjectByProperty('uuid', uuid) ??
		get(globalScene)?.getObjectByProperty('uuid', uuid)
	);
}

/**
 * The object a note hangs on (objectsGroup OR the scene root). Exported so the
 * marker overlay can resolve owners on its own schedule instead of walking the
 * whole scene per note per frame. @param {string} uuid
 */
export function annotationOwner(uuid) {
	return objectOf(uuid) ?? null;
}

/** @param {any} data */
function broadcast(data) {
	/** @type {any} */
	const peer = get(peers);
	if (peer) peer.send(data);
}

/** Create/update locally and replicate @param {any} annotation */
export function setAnnotation(annotation) {
	const normalized = normalizeAnnotation(annotation);
	annotations.update((list) => {
		const index = list.findIndex((a) => a.id === normalized.id);
		if (index >= 0) {
			const next = [...list];
			next[index] = normalized;
			return next;
		}
		return [...list, normalized];
	});
	broadcast({ type: 'annotation', op: 'set', annotation: normalized });
}

/** @param {string} id */
export function deleteAnnotation(id) {
	annotations.update((list) => list.filter((a) => a.id !== id));
	broadcast({ type: 'annotation', op: 'delete', annotation: { id } });
	activeAnnotation.update((active) => (active?.id === id ? null : active));
}

/** Remote CRUD @param {any} data */
export function applyAnnotation(data) {
	if (data.op === 'delete') {
		annotations.update((list) => list.filter((a) => a.id !== data.annotation.id));
		activeAnnotation.update((active) => (active?.id === data.annotation.id ? null : active));
	} else {
		const normalized = normalizeAnnotation(data.annotation);
		annotations.update((list) => {
			const index = list.findIndex((a) => a.id === normalized.id);
			if (index >= 0) {
				const next = [...list];
				next[index] = normalized;
				return next;
			}
			return [...list, normalized];
		});
	}
}

/** Apply the full set from a peer (merge by id) @param {any[]} list */
export function applyAnnotationsSnapshot(list) {
	if (!Array.isArray(list)) return;
	list.forEach((annotation) => applyAnnotation({ op: 'set', annotation }));
}

/** Full-state reply on handshake, retrying until our connection back is open @param {string} peerId */
export function sendAnnotations(peerId, attempt = 0) {
	/** @type {any} */
	const peer = get(peers);
	if (!peer) return;
	const list = get(annotations);
	if (list.length === 0) return;
	const conn = peer.connections[peerId];
	if (!conn || !conn.open) {
		if (attempt < 20) setTimeout(() => sendAnnotations(peerId, attempt + 1), 500);
		return;
	}
	conn.send({ type: 'annotations', annotations: list });
}

/**
 * Start a new note on an object. Anchored at the EXACT pointed spot when a
 * world point is given (87), otherwise at the bounding-box top.
 * @param {string=} uuid - defaults to the selected object
 * @param {number[] | null=} worldPoint - raycast hit to pin at
 */
export function addAnnotation(uuid, worldPoint = null) {
	const targetUuid = uuid ?? get(selectedObject)?.uuid;
	const object = targetUuid ? objectOf(targetUuid) : null;
	if (!object) {
		showToast('Select an object to annotate');
		return;
	}
	let worldAnchor;
	if (worldPoint) {
		worldAnchor = new THREE.Vector3().fromArray(worldPoint);
	} else {
		const box = new THREE.Box3().setFromObject(object);
		worldAnchor = box.getCenter(tempVector.clone());
		worldAnchor.y = box.max.y + 0.25;
	}
	object.updateMatrixWorld(true);
	const offset = object.worldToLocal(worldAnchor.clone()).toArray();
	// H12: a SCENE-ROOT anchor (env rig, module content) is rebuilt with a fresh
	// uuid every boot — remember its fixed name so the note can re-key instead of
	// being pruned as an orphan.
	const inObjects = !!get(objectsGroup)?.getObjectByProperty('uuid', object.uuid);
	activeAnnotation.set({
		draft: normalizeAnnotation({
			id: crypto.randomUUID(),
			objectUuid: object.uuid,
			objectName: inObjects ? '' : object.name || '',
			offset,
			text: '',
			// H10: never the literal 'me' — the stored author must read correctly
			// for every peer and for anyone who loads the saved file
			author: myAuthorName(),
			authorKey: myAuthorKey(),
			ts: Date.now()
		})
	});
}

/**
 * Focus the camera on a pin and open its note. `mode` picks the popover face
 * (a bare `{id}` keeps meaning view, for back-compat).
 * NOTE: `flyTo` bails in VR/spectator and the popover is DOM (invisible
 * in-headset), so this degrades to a no-visible-change there.
 * @param {string} id @param {'view'|'edit'=} mode
 */
export function openAnnotation(id, mode = 'view') {
	const annotation = get(annotations).find((a) => a.id === id);
	if (!annotation) return;
	activeAnnotation.set({ id, mode });
	const object = objectOf(annotation.objectUuid);
	/** @type {any} */
	const camera = get(globalCamera);
	if (object) {
		const world = object.localToWorld(new THREE.Vector3().fromArray(annotation.offset));
		// approach along the current view direction, stopping ~4m from the pin
		const direction = camera
			? camera.position.clone().sub(world).normalize()
			: new THREE.Vector3(0.5, 0.4, 0.5).normalize();
		flyTo(world.clone().add(direction.multiplyScalar(4)), world);
	}
}

/**
 * World position of a pin right now (drives the popover's projection loop).
 * Accepts a stored note id OR a draft-shaped object (`{objectUuid, offset}`),
 * so a not-yet-saved note anchors at the clicked point too.
 * @param {string | any} idOrAnnotation
 */
export function annotationWorldPosition(idOrAnnotation) {
	const annotation =
		typeof idOrAnnotation === 'string'
			? get(annotations).find((a) => a.id === idOrAnnotation)
			: idOrAnnotation;
	if (!annotation?.objectUuid || !Array.isArray(annotation.offset)) return null;
	const object = objectOf(annotation.objectUuid);
	if (!object) return null;
	return object.localToWorld(new THREE.Vector3().fromArray(annotation.offset));
}

/**
 * H12: re-key notes whose SCENE-ROOT anchor came back with a new uuid (env rig /
 * module content is rebuilt every boot). Local heal — the corrected uuid rides
 * the next save/edit; peers heal the same way from their own scene.
 * @returns {number} how many notes were re-keyed
 */
export function healAnnotationAnchors() {
	let healed = 0;
	annotations.update((list) => {
		const next = list.map((a) => {
			if (!a.objectName || objectOf(a.objectUuid)) return a;
			const found = get(globalScene)?.getObjectByName(a.objectName);
			if (!found) return a;
			healed++;
			return { ...a, objectUuid: found.uuid };
		});
		return healed ? next : list;
	});
	return healed;
}

// Pins die with their object (deletion replicates, so every peer prunes the same)
// — but only after a GRACE window: a restore/regeneration briefly has the note
// without its object, and pruning inside that gap silently ate notes (H12).
const PRUNE_GRACE_MS = 3000;
/** @type {Map<string, number>} */
const missingSince = new Map();
let pruneTimer = /** @type {any} */ (null);

/** One heal-then-prune sweep (exported for tests; normally debounced below) */
export function sweepAnnotations() {
	if (!get(objectsGroup)) return;
	healAnnotationAnchors();
	const now = Date.now();
	annotations.update((list) => {
		const kept = list.filter((a) => {
			// objectOf also sees scene-root system objects (env rig, module content)
			if (objectOf(a.objectUuid)) {
				missingSince.delete(a.id);
				return true;
			}
			const first = missingSince.get(a.id);
			if (first === undefined) {
				missingSince.set(a.id, now);
				return true;
			}
			if (now - first < PRUNE_GRACE_MS) return true;
			missingSince.delete(a.id);
			return false;
		});
		return kept.length === list.length ? list : kept;
	});
	// notes still inside the grace window need one more look after it expires —
	// objectsGroup may never tick again after the delete that orphaned them
	if (missingSince.size) {
		clearTimeout(pruneTimer);
		pruneTimer = setTimeout(sweepAnnotations, PRUNE_GRACE_MS + 100);
	}
}

objectsGroup.subscribe(() => {
	clearTimeout(pruneTimer);
	pruneTimer = setTimeout(sweepAnnotations, 500);
});

// persist with the autosave snapshot
registerAnnotationsPersistence(
	() => get(annotations),
	(list) => {
		annotations.set((Array.isArray(list) ? list : []).map(normalizeAnnotation));
		// H12: a restored scene-root anchor has a NEW uuid — re-key before the sweep
		// gets a chance to call the note an orphan
		healAnnotationAnchors();
	}
);

// H12: any annotation change schedules an autosave (notes were snapshot-only
// passengers before, so a note added after the last object change was lost)
annotations.subscribe(() => markAnnotationsDirty());
