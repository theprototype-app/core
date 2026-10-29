// VR controls — 52-browser (V4): THE ASSET BROWSER ON THE WRIST. The desktop's ways to get things into a
// scene — the packs, the free CC0 models (47-cc0), your own library + prefabs — as one panel on the
// OFF-HAND wrist (the menu hand; the other hand points). A grip lifts it off the wrist and lets go of it in
// the world, PINNED and bigger (1.6x); a grip on the pinned panel carries it again, and letting go near
// the wrist puts it back there (the Pin / To wrist button does both in one press). Search goes through the
// VR keyboard (filtering as you type). Picking a card puts the drag-to-place ghost on the laser
// (vr/placeRay.js): a trigger-DRAG out of the panel drops it where you let go, a click arms it for the next
// trigger, the stick turns it, a grip cancels. A free CC0 model downloads first (the card shows the
// progress), lands in your Library through the Explorer's own import, and then rides the laser.
//
// Hands (light hand tracking): a pinch IS the trigger — pick, pinch-drag out, release to drop — because the
// panel reads the session's selectstart/selectend, which a pinch fires.
//
// The panel is ONE canvas on ONE plane (assetBrowserDraw.js): one draw call, redrawn only when what it shows
// changes. It is an overlay panel (drawn over the scene, the laser ends on it), and a trigger that lands on
// it is the panel's — never a placement, never a select of whatever stands behind it.
//
// Data modules are PRIMED dynamic imports (the aiPanel rule): packs / explorer / the CC0 importer reach the
// history family, and a static edge from vr/ closes a loop a green build can still TDZ-crash in dev.
//
// LOCAL: which tab, the search, wrist-or-pinned — a fact about this headset, never replicated or saved
// (the pinned pose is not remembered across sessions either: a room you stood in yesterday is not this one).
import * as THREE from 'three';
import { get, writable } from 'svelte/store';
import { globalScene, globalRenderer, isVRMode, vrMenuOpen, vrMenuHand } from '../../stores/sceneStore';
import { prefabs, loadPrefabs } from '../prefabs';
import { openVRKeyboard, vrKeyboardTarget } from '../vrKeyboard';
import { registerVRMenuEntry, unregisterVRMenuEntry } from '../vrRadialMenu';
import { assetBrowserRes } from '../cc0/assetBrowserState.js';
import { registerVRFrameHook, registerVRTriggerHooks, registerGripHooks, registerStickOwner } from './hooks.js';
import { registerOverlayPanel } from './pointer.js';
import { controllerIndexFor, axesForSlot } from './input.js';
import { pointerHand, oneHandedHand } from './bindings.js';
import { hapticPulse } from './haptics.js';
import { beginVRPlace, cancelVRPlace, vrPlacing, rayPlace } from './placeRay.js';
import { drawAssetPanel, hitAtUv, PANEL_PX, PAGE_SIZE } from './assetBrowserDraw.js';

/** the radial entry: Add ▸ Assets */
export const RADIAL_ENTRY = { id: 'assets', group: 'add', order: 6.5 };
/** the panel in metres on the wrist; pinned it is PIN_SCALE times that */
export const PANEL_M = { w: 0.2, h: (0.2 * PANEL_PX.h) / PANEL_PX.w };
export const PIN_SCALE = 1.6;
/** where the panel rides, in the wrist hand's GRIP space: above the back of the hand, toward the elbow */
const WRIST_OFFSET = new THREE.Vector3(0, 0.085, 0.05);
/** a grip letting go of the panel within this of the wrist spot puts it back on the wrist */
const RETURN_RANGE = 0.2;
/** a grip whose hand is this close to the panel takes it, even without the laser on it */
const TOUCH_RANGE = 0.12;
const STICK_FLICK = 0.6;
const STICK_REARM = 0.3;
const MAX_FREE_ROWS = 400;

/** the browser is up (the radial entry toggles it) */
export const vrAssetBrowserOpen = writable(false);

/** @type {any} */ let packsRef = null;
/** @type {any} */ let explorerRef = null;
/** @type {any} */ let cc0FetchRef = null;
/** @type {any} */ let cc0CoreRef = null;
/** @type {any} */ let cc0ImportRef = null;
const primed = Promise.all([
	import('../packs').then((m) => (packsRef = m)),
	import('../explorer').then((m) => (explorerRef = m)),
	import('../cc0/cc0Fetch.js').then((m) => (cc0FetchRef = m)),
	import('../cc0/cc0Core.js').then((m) => (cc0CoreRef = m)),
	import('../cc0/cc0Import.js').then((m) => (cc0ImportRef = m))
]).catch(() => {});

/** @type {{tab: 'packs' | 'free' | 'library', pack: any, query: string, page: number}} */
const view = { tab: 'packs', pack: null, query: '', page: 0 };
/** @type {'wrist' | 'pinned' | 'held'} */
let mode = 'wrist';
/** what loaded: the pack items per pack name, the CC0 model rows, and a revision the redraw keys on */
const data = {
	/** @type {Record<string, any[]>} */ packItems: {},
	/** @type {any[] | null} */ free: null,
	freeError: '',
	loading: false,
	rev: 0
};
/** a one-line status (download progress, a refusal, a hint) */
let status = { text: '', tone: /** @type {'info' | 'warn' | 'bad'} */ ('info'), until: 0 };
/** downloads in flight: row key -> {done, total} (mirrors cc0Jobs) @type {Record<string, any>} */
let jobs = {};
/** the card that is on the laser now @type {string | null} */
let placingKey = null;

/** @type {any} */ let mesh = null;
/** @type {HTMLCanvasElement | null} */ let canvas = null;
/** @type {any} */ let texture = null;
/** @type {import('./assetBrowserDraw.js').PanelHit[]} */ let hits = [];
/** the button each controller slot's laser is on @type {(string | null)[]} */
const hover = [null, null];
/** per slot: the stick is armed for the next paging flick */
const stickArmed = [true, true];
let drawnSig = '';
/** the pinned / held pose (world) */
const pinned = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
/** a grip carrying the panel: slot + the panel's pose relative to that controller @type {any} */
let held = null;
/** the trailing 'select' of a press the panel took (a flag consumed once; see placeRay) */
let swallowNext = false;
let swallowSetAt = 0;
let mounted = false;
/** the suites' view */
const debug = { draws: 0, presses: /** @type {string[]} */ ([]), lastPress: /** @type {string | null} */ (null) };

// ---- images (thumbnails): one loaded <img> per url, a repaint when it arrives ------------------------
/** @type {Map<string, HTMLImageElement>} */
const images = new Map();
let imagesLoaded = 0;
/** @param {string} url @returns {HTMLImageElement | null} the image once loaded */
function imageFor(url) {
	if (!url || typeof Image === 'undefined') return null;
	let img = images.get(url);
	if (!img) {
		img = new Image();
		// a cross-origin image without CORS would TAINT the canvas, and a tainted canvas cannot be
		// uploaded as a texture at all — ask for CORS (jsDelivr and Poly Haven's CDN answer it)
		if (!url.startsWith('data:') && !url.startsWith('blob:')) img.crossOrigin = 'anonymous';
		img.onload = () => {
			imagesLoaded++;
		};
		img.onerror = () => {
			/** @type {any} */ (img).failed = true;
			imagesLoaded++;
		};
		img.src = url;
		images.set(url, img);
		if (images.size > 160) images.delete(/** @type {string} */ (images.keys().next().value));
	}
	return img.complete && img.naturalWidth > 0 ? img : null;
}

// ---- content ---------------------------------------------------------------------------------------------
/** @param {string} label */
const matches = (label) => {
	const words = view.query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!words.length) return true;
	const hay = String(label ?? '').toLowerCase();
	return words.every((w) => hay.includes(w));
};
/** the library payload of an Explorer record (the Explorer's own drag shape) @param {any} item */
function libraryPayload(item) {
	return { id: item.id, kind: item.kind, name: item.name, prefabId: null, url: null, ...(item.dims ? { dims: item.dims } : {}) };
}

/**
 * Every entry the current tab lists (before paging): {key, label, sub, thumb, badge, progress, folder, act}.
 * @returns {any[]}
 */
function entries() {
	if (view.tab === 'packs') {
		if (!view.pack) {
			const list = packsRef ? get(packsRef.packs) : [];
			return list
				.filter((/** @type {any} */ p) => matches(p.title || p.name))
				.map((/** @type {any} */ p) => ({
					key: 'pack:' + p.name,
					label: p.title || p.name,
					sub: p.source === 'imported' ? 'Your pack' : p.listUrl ? 'Pack' : 'Install on desktop',
					folder: true,
					act: { type: 'pack', pack: p }
				}));
		}
		const items = data.packItems[view.pack.name] ?? [];
		return items
			.filter((/** @type {any} */ it) => matches(it.label || it.name))
			.map((/** @type {any} */ it) => ({
				key: 'item:' + view.pack.name + '/' + it.name,
				label: it.label || it.name,
				sub: it.dims?.known && it.dims.size ? it.dims.size.map((/** @type {number} */ v) => v.toFixed(1)).join('×') + ' m' : '',
				thumb: it.resolvedThumb || it.thumbs?.[0] || null,
				badge: it.behavior ? '▶' : '',
				act: {
					type: 'place',
					payload: it.imported
						? libraryPayload(it)
						: {
								id: null,
								kind: 'object',
								name: it.name,
								prefabId: null,
								url: it.glbUrl,
								...(it.lods ? { lods: it.lods } : {}),
								...(it.behavior ? { behavior: it.behavior } : {}),
								...(it.dims ? { dims: it.dims } : {}),
								packName: it.packName
							}
				}
			}));
	}
	if (view.tab === 'free') {
		const rows = data.free ?? [];
		const filtered = cc0CoreRef ? cc0CoreRef.filterRows(rows, { query: view.query }) : rows;
		return filtered.slice(0, MAX_FREE_ROWS).map((/** @type {any} */ row) => {
			const key = 'cc0:' + row.id;
			const held = cc0ImportRef?.heldItemFor(row);
			const job = jobs[cc0ImportRef?.rowKey(row) ?? ''];
			return {
				key,
				label: row.name,
				sub: 'Poly Haven · CC0',
				thumb: row.thumb,
				badge: held ? '✓' : '↓',
				progress: job ? (job.total ? job.done / job.total : 0) : null,
				act: { type: 'cc0', row }
			};
		});
	}
	// library: your models, newest first, then your prefabs
	const items = explorerRef ? get(explorerRef.explorerItems) : [];
	const models = items
		.filter((/** @type {any} */ it) => it.kind === 'object' && matches(it.name))
		.sort((/** @type {any} */ a, /** @type {any} */ b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
		.map((/** @type {any} */ it) => ({
			key: 'lib:' + it.id,
			label: String(it.name).replace(/\.\w+$/, ''),
			sub: it.source?.site === 'polyhaven' ? 'Poly Haven' : 'Model',
			thumb: it.thumbnail || null,
			act: { type: 'place', payload: libraryPayload(it) }
		}));
	const prefabCards = get(prefabs)
		.filter((/** @type {any} */ p) => matches(p.name))
		.map((/** @type {any} */ p) => ({
			key: 'prefab:' + p.id,
			label: p.name,
			sub: 'Prefab',
			thumb: p.thumbnail || null,
			act: { type: 'place', payload: { prefabId: p.id, kind: 'prefab', name: p.name } }
		}));
	return [...models, ...prefabCards];
}

function emptyText() {
	if (view.tab === 'free') return data.freeError || (data.free ? 'Nothing matches' : 'Loading…');
	if (view.tab === 'library') return view.query ? 'Nothing matches' : 'Your library has no models yet';
	return view.query ? 'Nothing matches' : view.pack ? 'This pack lists no models' : 'No packs';
}

/** @returns {import('./assetBrowserDraw.js').PanelView} */
function currentView() {
	const all = entries();
	const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
	if (view.page >= pages) view.page = pages - 1;
	if (view.page < 0) view.page = 0;
	const slice = all.slice(view.page * PAGE_SIZE, view.page * PAGE_SIZE + PAGE_SIZE);
	const placing = get(vrPlacing);
	let text = status.text && Date.now() < status.until ? status.text : '';
	let tone = status.tone;
	// what the trigger does NOW outranks a passing note; a warning or a refusal still shows
	if (placing && (!text || tone === 'info')) {
		const handSource = sourceIsHand(placing.hand);
		text = handSource
			? placing.armed
				? `${placing.label}: pinch to place · grip to stop`
				: `${placing.label}: let go over the world to drop it`
			: placing.armed
				? `${placing.label}: trigger places · stick turns · grip stops`
				: `${placing.label}: let go of the trigger over the world`;
		tone = 'info';
	}
	return {
		tab: view.tab,
		crumb: view.tab === 'packs' && view.pack ? view.pack.title || view.pack.name : null,
		query: view.query,
		cards: slice.map((e) => ({ key: e.key, label: e.label, sub: e.sub, thumb: e.thumb, badge: e.badge, progress: e.progress ?? null, folder: e.folder, placing: !!placing && e.key === placingKey })),
		page: view.page,
		pages,
		total: all.length,
		status: text,
		statusTone: tone,
		loading: data.loading,
		pinned: mode !== 'wrist',
		empty: emptyText()
	};
}

/** @param {string} text @param {'info' | 'warn' | 'bad'} [tone] @param {number} [ms] */
function say(text, tone = 'info', ms = 4000) {
	status = { text, tone, until: Date.now() + ms };
}

// ---- loading -----------------------------------------------------------------------------------------------
async function loadTab() {
	await primed;
	if (view.tab === 'packs') {
		if (!get(packsRef.packs).length) {
			data.loading = true;
			try {
				await packsRef.loadPacks();
			} finally {
				data.loading = false;
			}
		}
		if (view.pack && !data.packItems[view.pack.name]) {
			data.loading = true;
			const pack = view.pack;
			try {
				data.packItems[pack.name] = await packsRef.listPackItems(pack);
			} finally {
				data.loading = false;
			}
		}
	} else if (view.tab === 'free') {
		if (!data.free) {
			data.loading = true;
			try {
				const list = await cc0FetchRef.phList('models');
				data.free = cc0CoreRef.normalizePolyHaven(list.data, 'models');
				data.freeError = '';
			} catch (err) {
				data.free = [];
				data.freeError = cc0ImportRef?.errorText?.(err) ?? 'The free models could not load';
			} finally {
				data.loading = false;
			}
		}
	} else {
		await explorerRef.loadExplorer?.();
		void loadPrefabs?.();
	}
	data.rev++;
}

// ---- actions -------------------------------------------------------------------------------------------
/** what a hand is: a tracked hand (no controller) @param {string | null | undefined} hand */
function sourceIsHand(hand) {
	const r = /** @type {any} */ (get(globalRenderer));
	const session = r?.xr?.getSession?.();
	if (!session || !hand) return false;
	for (const s of session.inputSources) if (s.handedness === hand) return !!s.hand;
	return false;
}

/** the handedness of controller slot `index` @param {number} index @returns {'left' | 'right'} */
function handOfSlot(index) {
	const r = /** @type {any} */ (get(globalRenderer));
	const h = r?.xr?.getController(index)?.userData?.handedness;
	return h === 'left' || h === 'right' ? h : pointerHand();
}

/**
 * Press a panel control. `index` is the controller slot whose trigger (or pinch) pressed — a card it picks
 * rides THAT hand's laser, with the trigger still down (a drag).
 * @param {string} id @param {number} [index]
 */
export function pressAssetButton(id, index = -1) {
	debug.presses.push(id);
	debug.lastPress = id;
	const hand = index >= 0 ? handOfSlot(index) : pointerHand();
	if (id === 'close') return closeVRAssetBrowser();
	if (id === 'pin') return mode === 'wrist' ? pinInFront() : returnToWrist();
	if (id.startsWith('tab:')) {
		const tab = /** @type {any} */ (id.slice(4));
		if (tab !== view.tab) {
			view.tab = tab;
			view.page = 0;
			view.query = '';
			view.pack = null;
			void loadTab();
		}
		return;
	}
	if (id === 'back') {
		view.pack = null;
		view.page = 0;
		view.query = '';
		data.rev++;
		return;
	}
	if (id === 'clear') {
		view.query = '';
		view.page = 0;
		data.rev++;
		return;
	}
	if (id === 'search') return openSearch();
	if (id.startsWith('page:')) {
		view.page += Number(id.slice(5)) || 0;
		data.rev++;
		return;
	}
	if (id.startsWith('card:')) {
		const key = id.slice(5);
		const entry = entries().find((e) => e.key === key);
		if (!entry) return;
		return pickEntry(entry, hand, index >= 0);
	}
}

/** @param {any} entry @param {'left' | 'right'} hand @param {boolean} dragging */
function pickEntry(entry, hand, dragging) {
	const act = entry.act;
	if (act.type === 'pack') {
		if (!act.pack.listUrl && act.pack.source !== 'imported') {
			say('This pack installs from the Explorer on the desktop', 'warn');
			return;
		}
		view.pack = act.pack;
		view.page = 0;
		view.query = '';
		void loadTab();
		return;
	}
	if (act.type === 'place') return placeEntry(entry.key, act.payload, hand, dragging);
	if (act.type === 'cc0') {
		const heldItem = cc0ImportRef?.heldItemFor(act.row);
		if (heldItem) return placeEntry(entry.key, libraryPayload(heldItem), hand, dragging);
		return downloadThenPlace(entry.key, act.row, hand);
	}
}

/** @param {string} key @param {any} payload @param {'left' | 'right'} hand @param {boolean} dragging */
function placeEntry(key, payload, hand, dragging) {
	placingKey = key;
	const ok = beginVRPlace(payload, {
		hand,
		dragging,
		repeat: true,
		onEnd: () => {
			if (placingKey === key) placingKey = null;
		}
	});
	if (!ok) placingKey = null;
}

/** a free model: download into the Library (the card shows it), then onto the laser @param {string} key @param {any} row @param {'left' | 'right'} hand */
async function downloadThenPlace(key, row, hand) {
	await primed;
	if (jobs[cc0ImportRef.rowKey(row)]) return; // already on its way
	say(`Downloading ${row.name}…`, 'info', 60000);
	try {
		const { item } = await cc0ImportRef.importCc0(row, get(assetBrowserRes));
		say(`${row.name} is in your Library`, 'info', 3000);
		// only if nothing else was picked meanwhile and the browser is still up
		if (item && get(vrAssetBrowserOpen) && !get(vrPlacing)) placeEntry(key, libraryPayload(item), hand, false);
	} catch (err) {
		say(cc0ImportRef.errorText(err), 'bad', 6000);
	}
	data.rev++;
}

function openSearch() {
	openVRKeyboard({
		title: view.tab === 'free' ? 'Search free models' : view.tab === 'library' ? 'Search your library' : view.pack ? `Search ${view.pack.title || view.pack.name}` : 'Search packs',
		initial: view.query,
		onInput: (/** @type {string} */ text) => {
			view.query = text;
			view.page = 0;
			data.rev++;
		},
		onCommit: (/** @type {string} */ text) => {
			view.query = text.trim();
			view.page = 0;
			data.rev++;
		},
		onCancel: () => {}
	});
}

// ---- open / close / pose ---------------------------------------------------------------------------
/** Open the browser (on the wrist, or pinned in front when one-handed). */
export function openVRAssetBrowser() {
	ensureMesh();
	if (oneHandedHand()) {
		mode = 'wrist';
		pinInFront();
	}
	vrAssetBrowserOpen.set(true);
	void loadTab();
}
export function closeVRAssetBrowser() {
	vrAssetBrowserOpen.set(false);
	if (placingKey) cancelVRPlace('closed');
	held = null;
}
export function toggleVRAssetBrowser() {
	if (get(vrAssetBrowserOpen)) closeVRAssetBrowser();
	else openVRAssetBrowser();
}

function ensureMesh() {
	if (mesh || typeof document === 'undefined') return mesh;
	canvas = document.createElement('canvas');
	canvas.width = PANEL_PX.w;
	canvas.height = PANEL_PX.h;
	texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;
	texture.anisotropy = 4;
	mesh = new THREE.Mesh(
		new THREE.PlaneGeometry(PANEL_M.w, PANEL_M.h),
		new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false })
	);
	mesh.name = 'vr-asset-browser';
	mesh.visible = false;
	return mesh;
}

/** the off hand: the menu hand (the other one points); null when one-handed @returns {'left' | 'right' | null} */
export function wristHand() {
	if (oneHandedHand()) return null;
	return pointerHand() === 'left' ? 'right' : 'left';
}

/** the headset camera's world position, or null */
function headPosition() {
	const r = /** @type {any} */ (get(globalRenderer));
	if (!r?.xr?.isPresenting) return null;
	const cam = r.xr.getCamera();
	cam.updateMatrixWorld?.(true);
	return cam.getWorldPosition(new THREE.Vector3());
}

/** the wrist spot (world) of the off hand, or null when it is not tracked */
function wristSpot() {
	const hand = wristHand();
	const r = /** @type {any} */ (get(globalRenderer));
	if (!hand || !r?.xr) return null;
	const index = controllerIndexFor(hand);
	if (index < 0) return null;
	const grip = r.xr.getControllerGrip(index);
	if (!grip || grip.visible === false) return null;
	grip.updateMatrixWorld(true);
	return grip.localToWorld(WRIST_OFFSET.clone());
}

/** face `object` toward the head, upright @param {any} object @param {any} head */
function faceHead(object, head) {
	if (!head) return;
	const target = new THREE.Vector3(head.x, object.position.y + (head.y - object.position.y) * 0.6, head.z);
	object.lookAt(target);
}

/** Pin the panel in the world in front of the head, bigger. */
function pinInFront() {
	const head = headPosition();
	const r = /** @type {any} */ (get(globalRenderer));
	if (!head || !mesh) {
		mode = 'pinned';
		return;
	}
	const cam = r.xr.getCamera();
	const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion()));
	fwd.y = 0;
	if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
	fwd.normalize();
	mesh.position.copy(head).addScaledVector(fwd, 0.65);
	mesh.position.y -= 0.15;
	faceHead(mesh, head);
	pinned.position.copy(mesh.position);
	pinned.quaternion.copy(mesh.quaternion);
	mode = 'pinned';
	hapticPulse(0.25, 30);
}

/** Back to the wrist (one-handed: nowhere to go — it stays pinned). */
function returnToWrist() {
	if (!wristHand()) {
		say('One-handed: the panel stays in the world', 'warn');
		return;
	}
	mode = 'wrist';
	hapticPulse(0.25, 30);
}

/** world pose of controller slot `index` @param {number} index */
function controllerPose(index) {
	const r = /** @type {any} */ (get(globalRenderer));
	const c = r?.xr?.getController(index);
	if (!c) return null;
	c.updateMatrixWorld(true);
	return { position: c.getWorldPosition(new THREE.Vector3()), quaternion: c.getWorldQuaternion(new THREE.Quaternion()) };
}

/** pose the mesh for this frame (wrist / pinned / held) */
function pose() {
	const head = headPosition();
	if (mode === 'held' && held) {
		const p = controllerPose(held.index);
		if (p) {
			mesh.position.copy(held.relPos).applyQuaternion(p.quaternion).add(p.position);
			mesh.quaternion.copy(p.quaternion).multiply(held.relQuat);
			const s = mesh.scale.x + (PIN_SCALE - mesh.scale.x) * 0.25;
			mesh.scale.setScalar(s);
		}
		return true;
	}
	if (mode === 'pinned') {
		mesh.position.copy(pinned.position);
		mesh.quaternion.copy(pinned.quaternion);
		mesh.scale.setScalar(PIN_SCALE);
		return true;
	}
	const spot = wristSpot();
	if (!spot) return false;
	mesh.position.copy(spot);
	mesh.scale.setScalar(1);
	faceHead(mesh, head);
	return true;
}

// ---- the laser ---------------------------------------------------------------------------------------
const _ray = new THREE.Raycaster();
/** the panel hit of controller slot `index`'s laser, or null @param {number} index */
function laserHit(index) {
	if (!mesh?.visible || index < 0) return null;
	const r = /** @type {any} */ (get(globalRenderer));
	const c = r?.xr?.getController(index);
	if (!c) return null;
	c.updateMatrixWorld(true);
	const m = new THREE.Matrix4().extractRotation(c.matrixWorld);
	_ray.ray.origin.setFromMatrixPosition(c.matrixWorld);
	_ray.ray.direction.set(0, 0, -1).applyMatrix4(m);
	_ray.far = 4;
	return _ray.intersectObject(mesh, false)[0] ?? null;
}
/** the control under slot `index`'s laser @param {number} index */
function buttonAt(index) {
	const hit = laserHit(index);
	return hit?.uv ? hitAtUv(hits, hit.uv) : null;
}
/** is slot `index` the wrist hand while the panel rides it? (it cannot point at its own wrist) @param {number} index */
function isWristSlot(index) {
	return mode === 'wrist' && index === controllerIndexFor(wristHand() ?? '');
}

// ---- per frame -----------------------------------------------------------------------------------------
/**
 * Repaint when what the panel shows could have changed. The INPUTS are compared first (a few numbers and
 * strings, every frame) — building the view walks whole lists (400 free models, the library), which is not
 * a per-frame cost at 72-90 Hz.
 */
function redraw() {
	const placing = get(vrPlacing);
	const inputs = [
		data.rev,
		data.loading,
		view.tab,
		view.pack?.name ?? '',
		view.query,
		view.page,
		hover[0],
		hover[1],
		imagesLoaded,
		JSON.stringify(jobs),
		status.text && Date.now() < status.until ? status.text : '',
		placing ? placing.label + '|' + placing.hand + '|' + placing.armed : '',
		placingKey,
		mode === 'wrist'
	].join('\u0001');
	if (inputs === drawnSig) return;
	drawnSig = inputs;
	const g = /** @type {CanvasRenderingContext2D} */ (canvas?.getContext('2d'));
	if (!g) return;
	const t0 = performance.now();
	hits = drawAssetPanel(g, currentView(), { images: (url) => imageFor(url), hover: hover[0] ?? hover[1] });
	texture.needsUpdate = true;
	perf.paintMs += performance.now() - t0;
	debug.draws++;
}

/** the suites' cost reading: frame-hook time (ms, summed), frames, repaints and their paint time */
const perf = { frames: 0, frameMs: 0, paintMs: 0 };
/** this frame's laser-on-panel per slot (the stick owner asks every frame; one raycast per slot) */
const onPanelNow = [false, false];

function frame() {
	if (!mesh) return;
	const t0 = performance.now();
	frameBody();
	if (mesh.visible) {
		perf.frames++;
		perf.frameMs += performance.now() - t0;
	}
}

function frameBody() {
	const r = /** @type {any} */ (get(globalRenderer));
	const live = get(vrAssetBrowserOpen) && !!r?.xr?.isPresenting && get(isVRMode);
	if (!live) {
		mesh.visible = false;
		held = null;
		if (mode === 'held') mode = 'pinned';
		return;
	}
	const scene = /** @type {any} */ (get(globalScene));
	if (scene && mesh.parent !== scene) scene.add(mesh);
	// the radial owns the wrist hand while it is open there: the panel steps aside
	const radialOnWrist = mode === 'wrist' && get(vrMenuOpen) && get(vrMenuHand) === wristHand();
	mesh.visible = pose() && !radialOnWrist;
	mesh.updateMatrixWorld(true);
	jobs = cc0ImportRef ? get(cc0ImportRef.cc0Jobs) : {};
	for (const i of [0, 1]) {
		const hit = isWristSlot(i) || !mesh.visible ? null : laserHit(i);
		hover[i] = hit?.uv ? (hitAtUv(hits, hit.uv)?.id ?? null) : null;
		// the laser on the panel: that hand's stick pages (up = back, down = forward)
		const onPanel = !!hit;
		onPanelNow[i] = onPanel;
		const y = onPanel ? (axesForSlot(i)[3] ?? 0) : 0;
		if (stickArmed[i] && Math.abs(y) > STICK_FLICK) {
			stickArmed[i] = false;
			view.page += y > 0 ? 1 : -1;
			data.rev++;
			hapticPulse(0.1, 12, handOfSlot(i));
		} else if (!stickArmed[i] && Math.abs(y) < STICK_REARM) stickArmed[i] = true;
	}
	redraw();
}

/** which slots' lasers are on the panel (their sticks page instead of turning) */
function stickHand() {
	for (const i of [0, 1]) if (mesh?.visible && onPanelNow[i]) return handOfSlot(i);
	return null;
}

// ---- trigger + grip ----------------------------------------------------------------------------------
/** the keyboard or the radial is up over everything: the panel stands aside for its presses */
function panelBusy() {
	return !!get(vrKeyboardTarget) || get(vrMenuOpen);
}

/** @param {number} index */
function onTriggerStart(index) {
	if (!mesh?.visible || panelBusy() || isWristSlot(index)) return false;
	const hit = laserHit(index);
	if (!hit) return false;
	// the panel's press: never a select of what stands behind it, never a placement
	swallowNext = true;
	swallowSetAt = Date.now();
	const button = hit.uv ? hitAtUv(hits, hit.uv) : null;
	if (button) {
		pressAssetButton(button.id, index);
		hapticPulse(0.2, 20, handOfSlot(index));
	}
	return true;
}

/** @param {number} index */
function onGripStart(index) {
	if (!mesh?.visible || held || isWristSlot(index)) return false;
	const p = controllerPose(index);
	if (!p) return false;
	const near = p.position.distanceTo(mesh.getWorldPosition(new THREE.Vector3())) < TOUCH_RANGE * Math.max(1, mesh.scale.x);
	if (!near && !laserHit(index)) return false;
	const inv = p.quaternion.clone().invert();
	held = {
		index,
		relPos: mesh.position.clone().sub(p.position).applyQuaternion(inv),
		relQuat: inv.multiply(mesh.quaternion.clone())
	};
	mode = 'held';
	hapticPulse(0.3, 30, handOfSlot(index));
	return true;
}

/** @param {number} index */
function onGripEnd(index) {
	if (!held || held.index !== index) return false;
	held = null;
	const spot = wristSpot();
	if (spot && mesh.position.distanceTo(spot) < RETURN_RANGE) {
		mode = 'wrist';
	} else {
		pinned.position.copy(mesh.position);
		pinned.quaternion.copy(mesh.quaternion);
		mode = 'pinned';
	}
	hapticPulse(0.25, 30, handOfSlot(index));
	return true;
}

// ---- mount -------------------------------------------------------------------------------------------
/** Mount the panel + its hooks + the radial entry; returns the teardown (VRAssetBrowser.svelte). */
export function mountVRAssetBrowser() {
	if (mounted) return () => {};
	mounted = true;
	const panel = ensureMesh();
	if (!panel) return () => {};
	const undo = [
		registerOverlayPanel(panel),
		registerVRFrameHook(frame),
		registerVRTriggerHooks({
			start: onTriggerStart,
			end: () => {
				swallowNext = false; // the press is over (a headset's select came just before this)
				return false;
			},
			// the panel's press — and, whatever the runtime's event order (IWER fires select BEFORE
			// selectstart), any select whose laser is on the panel: never a select of what is behind it
			swallow: (/** @type {number} */ index) =>
				(swallowNext && Date.now() - swallowSetAt < 5000) || (!panelBusy() && index >= 0 && !isWristSlot(index) && !!laserHit(index))
		}),
		registerGripHooks({ start: onGripStart, end: onGripEnd }),
		registerStickOwner(stickHand),
		// a refreshed library / prefab list / pack list repaints the cards
		prefabs.subscribe(() => (data.rev++)),
		vrPlacing.subscribe(() => (data.rev++)),
		rayPlace.subscribe(() => {})
	];
	primed.then(() => {
		if (!mounted) return;
		undo.push(packsRef.packs.subscribe(() => data.rev++));
		undo.push(explorerRef.explorerItems.subscribe(() => data.rev++));
	});
	registerVRMenuEntry({
		...RADIAL_ENTRY,
		label: 'Assets',
		icon: 'package',
		closes: true,
		active: () => get(vrAssetBrowserOpen),
		action: () => toggleVRAssetBrowser()
	});
	undo.push(() => unregisterVRMenuEntry(RADIAL_ENTRY.id, RADIAL_ENTRY.group));
	return () => {
		mounted = false;
		for (const fn of undo) fn();
		closeVRAssetBrowser();
		panel.parent?.remove(panel);
		panel.visible = false;
	};
}

// ---- the suites -----------------------------------------------------------------------------------------
/** the panel as a PNG data URL (the suites' evidence shots) */
export function assetPanelImage() {
	return canvas ? canvas.toDataURL('image/png') : null;
}
/** world point of a control's centre (for aiming a controller at it), or null @param {string} id */
export function assetControlPoint(id) {
	const r = hits.find((h) => h.id === id);
	if (!r || !mesh) return null;
	mesh.updateMatrixWorld(true);
	const u = (r.x + r.w / 2) / PANEL_PX.w;
	const v = (r.y + r.h / 2) / PANEL_PX.h;
	return mesh.localToWorld(new THREE.Vector3((u - 0.5) * PANEL_M.w, (0.5 - v) * PANEL_M.h, 0)).toArray();
}
export function vrAssetBrowserDebug() {
	const v = currentView();
	return {
		open: get(vrAssetBrowserOpen),
		visible: !!mesh?.visible,
		mode,
		wristHand: wristHand(),
		tab: view.tab,
		pack: view.pack?.name ?? null,
		query: view.query,
		page: view.page,
		pages: v.pages,
		total: v.total,
		cards: v.cards.map((c) => c.key),
		status: v.status,
		placingKey,
		hover: hover.slice(),
		buttons: hits.map((h) => h.id),
		position: mesh ? mesh.position.toArray() : null,
		scale: mesh ? mesh.scale.x : null,
		draws: debug.draws,
		presses: debug.presses.slice(),
		lastPress: debug.lastPress,
		loading: data.loading,
		freeCount: data.free?.length ?? null,
		perf: { ...perf }
	};
}
