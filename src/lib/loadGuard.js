// The reporting half of loadGuardCore.js: every place that rebuilds an object or a material set
// from JSON it did not just make itself goes through here, so the check, the count and the one
// toast are the same everywhere. See loadGuardCore.js for the rules.
import * as THREE from 'three';
import { guardObjectJson, guardMaterialSet, guardChanged, guardGltfElement, isEmbeddedUrl, isLocalImageUrl, stlWithinLimits } from './loadGuardCore.js';
import { fbxWithinLimits } from './fbxGuard.js';
export { isLocalImageUrl };
import { noteWireError } from './wireErrors.js';
import { showToast } from '../stores/appStore';

let toldThisSession = false;
/** @type {{refused: number, materials: number, images: number, textures: number, fetches: number}} */
const totals = { refused: 0, materials: 0, images: 0, textures: 0, fetches: 0 };

/** What the checks changed since the page loaded (diagnostics and tests). */
export function loadGuardTotals() {
	return { ...totals };
}

/** Tests: start counting (and toasting) afresh. */
export function resetLoadGuard() {
	toldThisSession = false;
	for (const key of /** @type {(keyof typeof totals)[]} */ (Object.keys(totals))) totals[key] = 0;
}

function tellOnce() {
	if (toldThisSession) return;
	toldThisSession = true;
	showToast('Some objects were loaded in a simpler form: they carried content this app only accepts from its own editors.');
}

/**
 * @param {string} from who it came from: a peer id, or 'file' / 'library' / 'device'
 * @param {string} what the message type or the loading path
 * @param {import('./loadGuardCore.js').GuardResult} result
 */
function report(from, what, result) {
	if (!guardChanged(result)) return;
	if (!result.ok) totals.refused++;
	totals.materials += result.materials;
	totals.images += result.images;
	totals.textures += result.textures;
	const detail = result.ok
		? `materials ${result.materials}, images ${result.images}, textures ${result.textures}`
		: `refused (${result.reason})`;
	noteWireError(from || '?', 'checked:' + what, detail, { quiet: true });
	tellOnce();
}

/**
 * Check one ObjectLoader JSON in place. Returns false when it must not be parsed at all.
 * @param {any} json @param {string} from @param {string} what
 */
export function checkObjectJson(json, from, what) {
	const result = guardObjectJson(json);
	report(from, what, result);
	return result.ok;
}

/**
 * Check a `{materials, textures, images}` payload in place. False = do not apply it.
 * @param {any} payload @param {string} from @param {string} what
 */
export function checkMaterialSet(payload, from, what) {
	const result = guardMaterialSet(payload);
	report(from, what, result);
	return result.ok;
}

/**
 * Check a glTF element (an object, a JSON string or .glb bytes). False = do not parse it.
 * `{uris: false}` = sizes only, for a loader that already refuses fetches.
 * @param {any} element @param {string} from @param {string} what @param {{uris?: boolean}} [opts]
 */
export function checkGltf(element, from, what, opts) {
	const r = guardGltfElement(element, opts);
	if (!r.ok) report(from, what, { ok: false, reason: r.reason, materials: 0, images: 0, textures: 0 });
	return r.ok;
}

/**
 * Check binary FBX bytes before FBXLoader inflates them. False = do not parse it.
 * @param {ArrayBuffer | ArrayBufferView} bytes @param {string} from @param {string} what
 */
export function checkFbx(bytes, from, what) {
	const ok = fbxWithinLimits(bytes);
	if (!ok) report(from, what, { ok: false, reason: 'size', materials: 0, images: 0, textures: 0 });
	return ok;
}

/**
 * Check STL bytes before STLLoader sizes its arrays from the header. False = do not parse it.
 * @param {ArrayBuffer | ArrayBufferView} bytes @param {string} from @param {string} what
 */
export function checkStl(bytes, from, what) {
	const ok = stlWithinLimits(bytes);
	if (!ok) report(from, what, { ok: false, reason: 'size', materials: 0, images: 0, textures: 0 });
	return ok;
}

/** @param {unknown} url */
function isOwnBlob(url) {
	if (typeof url !== 'string') return false;
	const origin = typeof location !== 'undefined' ? location.origin : '';
	return !!origin && url.startsWith('blob:' + origin + '/');
}

/** A material's texture preview address, when it is one this page may show (see isLocalImageUrl).
 * Material `userData` arrives with objects from several routes, so every reader goes through this.
 * @param {any} material @returns {string|null} */
export function mapPreviewUrl(material) {
	const url = material?.userData?.mapDataUrl;
	return isLocalImageUrl(url) ? url : null;
}

/** Count and report one address a check refused to fetch. @param {string} from @param {string} what */
export function noteRefusedFetch(from, what) {
	totals.fetches++;
	noteWireError(from || '?', 'checked:' + what, 'refused a fetch', { quiet: true });
	tellOnce();
}

/**
 * A LoadingManager that refuses every URL that is not embedded content (data: or one of this
 * page's own blob: URLs). The second line behind the JSON check: the loaders that parse bytes or
 * JSON with no folder of their own have nothing legitimate to fetch.
 * @param {string} from @param {string} what
 */
export function embeddedOnlyManager(from, what) {
	const manager = new THREE.LoadingManager();
	manager.setURLModifier((url) => {
		// blob: only for this page's own (what a loader makes from embedded bytes)
		if (isEmbeddedUrl(url) || isOwnBlob(url)) return url;
		noteRefusedFetch(from, what);
		// an empty data URL: the image (or buffer) fails to decode and the loader reports it
		return 'data:,';
	});
	return manager;
}

/** The error a refused load throws; `loadCheck` tells a caller it was the check, not a broken file.
 * @param {string} what @returns {Error & {loadCheck: true}} */
export function refusal(what) {
	return Object.assign(new Error(what + ' refused by the load check'), { loadCheck: /** @type {const} */ (true) });
}

/**
 * Check, then parse with an ObjectLoader that cannot fetch. Throws when the JSON is refused, so
 * every caller's existing parse-failure path handles it.
 * @param {any} json @param {string} from @param {string} what
 */
export function parseCheckedObject(json, from, what) {
	if (!checkObjectJson(json, from, what)) throw refusal('object');
	return new THREE.ObjectLoader(embeddedOnlyManager(from, what)).parse(json);
}
