// 102-splats: THE SPLAT RUNTIME — reached only through splatTick's lazy import, so Spark (~1 MB gzip)
// loads with the first splat object a scene holds and never before.
//
// Per carrier (splatObject.js) one Spark SplatMesh at the SCENE ROOT, glued to the carrier's world
// matrix every frame (golden rule 5: a visual a serializer must never see lives outside objectsGroup,
// the textPath / water precedent). One SparkRenderer for the scene sorts every splat object together.
// The bytes are an Explorer file by content hash: read from this device's Library, or pulled from a
// peer (assetShare) with a watch that builds the mesh the moment they land.
//
// What hides a splat (the carrier stays, selectable): a hidden carrier or ancestor; Cinematic view (the
// WebGPU renderer cannot run Spark's GLSL — the view names "Splats" in its Not shown chip); the
// device's splat budget (a headset draws at most 1 M, whole objects in scene order, with one notice).
import { get } from 'svelte/store';
import { globalScene, globalRenderer } from '../../stores/sceneStore';
import { showToast } from '../../stores/appStore';
import { explorerItems, itemByHash, itemBlob } from '../explorer';
import { requestAsset } from '../assetShare';
import { cinematicState } from '../cinematic/cinematicStore.js';
import { finishTier } from '../post/finishCore.js';
import { isHeadsetUA } from '../hdri/hdriCore.js';
import { isSplatObject, applySplatProxyLook, applySplatTo } from './splatObject.js';
import { normalizeSplat, splatBudget, withinBudget, budgetNotice } from './splatCore.js';
import { splatStatus } from './splatStatus.js';
import { setTriangleDiscount } from '../sceneBudget.js';

/** the editor grid and other transparent helpers draw first; the splats composite over them */
const SPLAT_RENDER_ORDER = 10;

/** @type {any} */
let spark = null;
/** @type {Promise<any> | null} */
let sparkLoading = null;
/** @type {any} */
let sparkRenderer = null;

/**
 * @typedef {{ carrier: any, hash: string, mesh: any, edit: any, sdf: any, cropKey: string, state: 'loading'|'waiting'|'ready'|'error'|'off', error?: string }} Entry
 * @type {Map<string, Entry>}
 */
const entries = new Map();
/** records already normalized onto their carrier (a new object = a new write) @type {WeakSet<object>} */
const seenRecords = new WeakSet();
/** hashes asked of peers, built when they land @type {Set<string>} */
const awaiting = new Set();
/** @type {(() => void) | null} */
let stopWatch = null;
let budgetNoted = '';

function loadSpark() {
	if (spark) return Promise.resolve(spark);
	sparkLoading ??= import('@sparkjsdev/spark').then((m) => (spark = m));
	return sparkLoading;
}

function publishStatus() {
	/** @type {Record<string, {state: string, error?: string, shown: boolean}>} */
	const out = {};
	for (const [uuid, e] of entries) out[uuid] = { state: e.state, ...(e.error ? { error: e.error } : {}), shown: !!e.mesh?.visible };
	splatStatus.set(out);
}

function ensureRenderer() {
	const scene = /** @type {any} */ (get(globalScene));
	const renderer = /** @type {any} */ (get(globalRenderer));
	if (!scene || !renderer || !spark) return null;
	if (sparkRenderer && sparkRenderer.parent === scene) return sparkRenderer;
	if (!sparkRenderer) {
		sparkRenderer = new spark.SparkRenderer({ renderer });
		sparkRenderer.name = 'splat-renderer';
		sparkRenderer.userData.splatVisual = true;
		sparkRenderer.userData.localOnly = true;
		sparkRenderer.renderOrder = SPLAT_RENDER_ORDER;
		sparkRenderer.raycast = () => {};
	}
	scene.add(sparkRenderer);
	// the frame meter counts scene geometry; Spark's two triangles per splat are capped by the splat budget
	setTriangleDiscount((s) => (sparkRenderer && sparkRenderer.visible && sparkRenderer.parent === s ? (sparkRenderer.activeSplats ?? 0) * 2 : 0));
	return sparkRenderer;
}

function watchLibrary() {
	if (stopWatch) return;
	stopWatch = explorerItems.subscribe((items) => {
		if (!awaiting.size || !Array.isArray(items)) return;
		for (const hash of [...awaiting]) {
			if (!items.some((it) => it?.hash === hash)) continue;
			awaiting.delete(hash);
			for (const e of entries.values()) if (e.hash === hash && e.state === 'waiting') void build(e);
		}
	});
}

/** @param {Entry} e */
async function build(e) {
	const rec = normalizeSplat(e.carrier.userData.splat);
	const hash = rec.hash;
	e.state = 'loading';
	publishStatus();
	const item = hash ? itemByHash(hash) : null;
	if (!item) {
		e.state = 'waiting';
		awaiting.add(hash);
		watchLibrary();
		if (hash) requestAsset(hash);
		publishStatus();
		return;
	}
	try {
		const [mod, blob] = await Promise.all([loadSpark(), itemBlob(item.id)]);
		if (!blob) throw new Error('the file is missing from this device');
		if (entries.get(e.carrier.uuid) !== e || e.hash !== hash) return; // replaced or removed while loading
		if (!ensureRenderer()) throw new Error('no 3D view yet');
		const bytes = new Uint8Array(await blob.arrayBuffer());
		const mesh = new mod.SplatMesh({ fileBytes: bytes, fileName: rec.file || item.name });
		mesh.name = 'splat-visual';
		mesh.userData.splatVisual = true;
		mesh.userData.localOnly = true;
		mesh.userData.splatOf = e.carrier.uuid;
		mesh.matrixAutoUpdate = false;
		mesh.renderOrder = SPLAT_RENDER_ORDER;
		mesh.raycast = () => {};
		mesh.visible = false;
		/** @type {any} */ (get(globalScene))?.add(mesh);
		e.mesh = mesh;
		await mesh.initialized;
		if (entries.get(e.carrier.uuid) !== e) return dispose(e);
		e.state = 'ready';
		e.error = undefined;
	} catch (error) {
		e.state = 'error';
		e.error = String(/** @type {any} */ (error)?.message ?? error);
		console.log('splat load failed', rec.file, error);
		dispose(e, true);
	}
	publishStatus();
}

/** @param {Entry} e @param {boolean} [keepEntry] */
function dispose(e, keepEntry = false) {
	if (e.mesh) {
		e.mesh.removeFromParent();
		e.mesh.dispose?.();
		e.mesh = null;
	}
	e.edit = null;
	e.sdf = null;
	e.cropKey = '';
	if (!keepEntry) entries.delete(e.carrier.uuid);
}

/** the crop box as a Spark edit on the mesh (outside the box = transparent) @param {Entry} e @param {number[] | null} crop */
function applyCrop(e, crop) {
	const key = crop ? crop.join(',') : '';
	if (key === e.cropKey || !e.mesh || !spark) return;
	e.cropKey = key;
	if (!crop) {
		if (e.edit) e.edit.removeFromParent();
		e.edit = null;
		e.sdf = null;
		return;
	}
	if (!e.edit) {
		e.edit = new spark.SplatEdit({ rgbaBlendMode: spark.SplatEditRgbaBlendMode.MULTIPLY, invert: true, softEdge: 0 });
		e.sdf = new spark.SplatEditSdf({ type: spark.SplatEditSdfType.BOX, opacity: 0 });
		e.edit.addSdf(e.sdf);
		e.mesh.add(e.edit);
	}
	// the BOX sdf is a unit cube (half-extent 0.5) scaled to the crop, in the file's space
	e.sdf.position.set((crop[0] + crop[3]) / 2, (crop[1] + crop[4]) / 2, (crop[2] + crop[5]) / 2);
	e.sdf.scale.set(Math.max(1e-3, crop[3] - crop[0]), Math.max(1e-3, crop[4] - crop[1]), Math.max(1e-3, crop[5] - crop[2]));
	e.sdf.updateMatrixWorld?.(true);
}

/** @param {any} o is it shown, walking up to objectsGroup */
function shownInScene(o) {
	for (let p = o; p; p = p.parent) if (p.visible === false) return false;
	return true;
}

/** the tier this frame's budget belongs to */
function tier() {
	const renderer = /** @type {any} */ (get(globalRenderer));
	const nav = typeof navigator !== 'undefined' ? navigator : null;
	return finishTier({
		presenting: !!renderer?.xr?.isPresenting,
		headset: !!nav && isHeadsetUA(nav.userAgent),
		phone: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
	});
}

/** test seam: force the tier ('' = the device's) */
let tierOverride = '';

/**
 * The per-frame entry (splatTick calls it with the carriers it found).
 * @param {any[]} carriers
 */
export function tickSplats(carriers) {
	const live = new Set();
	const t = /** @type {'pc'|'phone'|'quest'} */ (tierOverride || tier());
	const cap = splatBudget(t);
	let changed = false;
	for (const c of carriers) {
		if (!isSplatObject(c)) continue;
		live.add(c.uuid);
		// a record written by the wire or by undo (a plain object, not yet normalized): normalize it and
		// keep the proxy box in step — applySplatTo rebuilds the box only when it changed
		if (!seenRecords.has(c.userData.splat)) {
			applySplatTo(c, c.userData.splat);
			seenRecords.add(c.userData.splat);
		}
		const hash = String(c.userData.splat.hash ?? '');
		let e = entries.get(c.uuid);
		if (e && (e.carrier !== c || e.hash !== hash)) {
			dispose(e);
			e = undefined;
		}
		if (!e) {
			applySplatProxyLook(c);
			// a budget of 0 = splats are off on this device: no Spark load and no build, only the notice
			e = { carrier: c, hash, mesh: null, edit: null, sdf: null, cropKey: '', state: cap > 0 ? 'loading' : 'off' };
			entries.set(c.uuid, e);
			if (cap > 0) void build(e);
			else changed = true;
		}
	}
	for (const e of [...entries.values()]) {
		if (cap > 0 && e.state === 'off') void build(e); // the tier changed (a test override): load it now
		if (!live.has(e.carrier.uuid)) {
			dispose(e);
			changed = true;
		}
	}
	const budget = withinBudget(
		[...entries.values()].filter((e) => e.state === 'ready' && shownInScene(e.carrier)).map((e) => ({ uuid: e.carrier.uuid, count: normalizeSplat(e.carrier.userData.splat).count })),
		cap
	);
	const hidden = [...budget.hidden, ...[...entries.values()].filter((e) => e.state === 'off' && shownInScene(e.carrier)).map((e) => e.carrier.uuid)];
	const cinematic = get(cinematicState).mode !== 'off';
	for (const e of entries.values()) {
		if (!e.mesh) continue;
		const rec = normalizeSplat(e.carrier.userData.splat);
		e.carrier.updateWorldMatrix(true, false);
		e.mesh.matrix.copy(e.carrier.matrixWorld);
		e.mesh.matrixWorldNeedsUpdate = true;
		e.mesh.opacity = rec.opacity;
		applyCrop(e, rec.crop);
		const show = e.state === 'ready' && !cinematic && budget.shown.has(e.carrier.uuid) && rec.opacity > 0;
		if (e.mesh.visible !== show) {
			e.mesh.visible = show;
			changed = true;
		}
	}
	if (sparkRenderer) sparkRenderer.visible = !cinematic;
	if (hidden.length) {
		const key = hidden.join(',');
		if (key !== budgetNoted) {
			budgetNoted = key;
			showToast(budgetNotice(t, cap, hidden.map((u) => entries.get(u)?.carrier.name || 'Splat')));
		}
	} else budgetNoted = '';
	if (changed) publishStatus();
	if (!entries.size && sparkRenderer) {
		sparkRenderer.removeFromParent();
		setTriangleDiscount(null);
	}
}

/** debug / e2e view */
export function splatDebug() {
	const scene = /** @type {any} */ (get(globalScene));
	return {
		sparkLoaded: !!spark,
		runtimeLoaded: true,
		rendererInScene: !!sparkRenderer && sparkRenderer.parent === scene,
		awaiting: [...awaiting],
		entries: [...entries.values()].map((e) => ({
			uuid: e.carrier.uuid,
			hash: e.hash,
			state: e.state,
			error: e.error ?? '',
			visible: !!e.mesh?.visible,
			numSplats: e.mesh?.packedSplats?.numSplats ?? e.mesh?.splats?.getNumSplats?.() ?? 0,
			crop: e.cropKey
		}))
	};
}

/** test seam */
export const splatRuntimeForTest = {
	/** @param {'' | 'pc' | 'phone' | 'quest'} t */
	setTier(t) {
		tierOverride = t;
	},
	/** the world-space box the scan covers (for a camera aim) @param {string} uuid */
	worldBox(uuid) {
		const e = entries.get(uuid);
		if (!e?.mesh) return null;
		const b = e.mesh.getBoundingBox?.(true);
		return b ? b.clone().applyMatrix4(e.mesh.matrix).toArray?.() ?? [b.min.toArray(), b.max.toArray()] : null;
	}
};

