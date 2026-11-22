import { get } from 'svelte/store';
import { objectsGroup, pokeScene } from '../stores/sceneStore';
import { peers, showToast } from '../stores/appStore';
import { recordEntry, beginHistoryBatch, endHistoryBatch, historyBatchOpen } from './history';
import { normalizeTextPath, normalizeLetterStyle, remapLetters, MAX_STYLED, textCapCheck, isBlockText } from './textPathCore.js';
import { coarsePointer } from './inputDevice.js';
import { isVRMode } from '../stores/sceneStore';
import { applyTextPathTo, bumpTextTurn, textTurn } from './textPathObject.js';
import { textPathSourceFor } from './textPathSources.js';
import { spawnAtPoint } from './addObjects.js';
import { isSplineObject, normalizeSpline } from './splineTube';

// 64 D2: the ONE write path for `userData.textPath` — the setFlowPathFor shape: merge,
// normalize, one `props` undo entry, the existing `objectParameters` message, a poke. A scrub
// (DragRow) or a typing session is ONE undo step through the 37 R26 gesture merge. The letters
// themselves never travel: every peer lays them out from the record (textPathRuntime).

/** @param {string} uuid */
const objectOf = (uuid) => get(objectsGroup)?.getObjectByProperty('uuid', uuid);

/** 'low' on a phone or in a headset (the TX6 caps; the runtime's textProfile, without its chunk) */
export function writerProfile() {
	const forced = typeof window !== 'undefined' ? /** @type {any} */ (window).__tpTextProfile : null;
	if (forced === 'low' || forced === 'desktop') return forced;
	return coarsePointer() || get(isVRMode) ? 'low' : 'desktop';
}

/** the last write refused, and why (the Inspector / agent tool read it) @type {string | null} */
let lastRefusal = null;
export const lastTextRefusal = () => lastRefusal;

/**
 * Would this change be refused? (64-text: extruded text on a path is out of scope; TX6 caps)
 * @param {any} before normalized @param {any} merged the raw merge, before normalizing
 * @returns {string | null} the plain message, or null
 */
export function refusalFor(before, merged) {
	if (merged.mode === 'extruded' && (merged.path?.kind ?? 'none') !== 'none')
		return 'Solid (extruded) text cannot follow a path: set Follows to None (a plain block of text) first, or keep it flat.';
	const next = normalizeTextPath(merged);
	// only a change that makes the text LONGER (or solid) is refused: shortening always goes through
	const grows = Array.from(next.text).length > Array.from(before.text).length || next.mode !== before.mode;
	if (!grows) return null;
	const cap = textCapCheck(next, writerProfile());
	return cap.ok ? null : cap.message;
}

/**
 * @param {string} uuid
 * @param {any} patch shallow; `path` merges one level down; a new `text` carries the letter
 *   styles along with their letters (remapLetters) unless the patch brings its own `letters`
 * @returns {import('./textPathCore.js').TextPathRecord | null}
 */
export function setTextPathFor(uuid, patch) {
	const object = objectOf(uuid);
	if (!object?.userData?.textPath || !patch || typeof patch !== 'object') return null;
	const before = normalizeTextPath(object.userData.textPath);
	const merged = { ...before, ...patch };
	if (patch.path) merged.path = { ...before.path, ...patch.path };
	if (patch.bevel) merged.bevel = { ...before.bevel, ...patch.bevel };
	if (typeof patch.text === 'string' && !('letters' in patch)) merged.letters = remapLetters(before.text, patch.text, before.letters);
	// a font change: a bundled font clears a Library one, and the other way round
	if (typeof patch.font === 'string' && !('fontAsset' in patch)) merged.fontAsset = null;
	const refusal = refusalFor(before, merged);
	lastRefusal = refusal;
	if (refusal) {
		showToast(refusal);
		return null;
	}
	const next = normalizeTextPath(merged);
	if (JSON.stringify(next) === JSON.stringify(before)) return before;
	bumpTextTurn(uuid);
	applyTextPathTo(object, next);
	recordEntry({ kind: 'props', uuid, before: { textPath: before }, after: { textPath: next } });
	/** @type {any} */
	const peer = get(peers);
	peer?.send({ type: 'objectParameters', parameter: 'textPath', uuid, textPath: next });
	pokeScene();
	return next;
}

/**
 * Style some letters (character indices): `patch` fields merge into each letter's style; a
 * field set to null goes back to "no change" (`{}` with `reset: true` clears them whole).
 * @param {string} uuid @param {number[]} indices @param {any} patch @param {{reset?: boolean}=} opts
 */
export function setLetterStyle(uuid, indices, patch, opts = {}) {
	const object = objectOf(uuid);
	if (!object?.userData?.textPath) return null;
	const rec = normalizeTextPath(object.userData.textPath);
	/** @type {Record<string, any>} */
	const letters = { ...rec.letters };
	for (const i of indices) {
		if (!Number.isInteger(i) || i < 0 || i >= rec.text.length) continue;
		const k = String(i);
		/** @type {Record<string, any>} */
		const merged = opts.reset ? {} : { ...(letters[k] ?? {}) };
		for (const [f, v] of Object.entries(patch ?? {})) {
			if (v === null || v === undefined) delete merged[f];
			else merged[f] = v;
		}
		const style = normalizeLetterStyle(merged);
		if (style) letters[k] = style;
		else delete letters[k];
	}
	if (Object.keys(letters).length > MAX_STYLED) return null;
	return setTextPathFor(uuid, { letters });
}

/** how far above a source's curve the baseline sits by default @param {any} o */
function clearanceOf(o) {
	if (isSplineObject(o)) {
		const data = normalizeSpline(o.userData.spline);
		return Math.max(0, ...data.points.map((p) => p.radius)) + 0.04;
	}
	return 0.02;
}

/**
 * "Put text on this path": a new text object linked to `targetUuid` (a spline, a flow path, a
 * registered 64-vector shape). ONE undo step for the create and the link.
 * @param {string} targetUuid @param {string=} text @returns {any | null} the text object
 */
export function putTextOnPath(targetUuid, text) {
	const target = objectOf(targetUuid);
	if (!target || !textPathSourceFor(target) || target.userData?.textPath) return null;
	target.updateWorldMatrix(true, false);
	const at = target.matrixWorld.elements;
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	let object = null;
	try {
		object = spawnAtPoint('/create Text', [at[12], at[13], at[14]]);
		if (object?.uuid)
			setTextPathFor(object.uuid, {
				...(typeof text === 'string' ? { text } : {}),
				path: { kind: 'object', target: targetUuid },
				align: 'start',
				offset: 0.02,
				shift: clearanceOf(target)
			});
	} finally {
		if (own) endHistoryBatch('Put text on a path');
	}
	return object;
}

/**
 * 64-text: a new text object (the agent tool's create, a template) — one undo step for the
 * create and its record. Refusals (cap, extruded on a path) remove the object again.
 * @param {any} patch the record fields @param {number[] | null} at world point or null (in front of the camera)
 * @returns {{object: any} | {error: string}}
 */
export function createTextObject(patch, at = null) {
	// refuse BEFORE anything is made: inside a caller's batch (an agent call) an undo cannot
	// take a half-made object back out
	if (patch && typeof patch === 'object') {
		const fresh = normalizeTextPath({ text: 'Text' });
		const why = refusalFor(fresh, { ...fresh, ...patch, ...(patch.path ? { path: { ...fresh.path, ...patch.path } } : {}) });
		if (why) {
			lastRefusal = why;
			showToast(why);
			return { error: why };
		}
	}
	const own = !historyBatchOpen();
	if (own) beginHistoryBatch();
	let object = null;
	let error = null;
	try {
		object = spawnAtPoint('/create Text', at);
		if (!object?.uuid || !object.userData?.textPath) error = 'Could not create the text.';
		else if (patch && Object.keys(patch).length && !setTextPathFor(object.uuid, patch)) error = lastRefusal ?? 'That text could not be set.';
	} finally {
		if (own) endHistoryBatch(error ? 'Text (refused)' : 'Add text');
	}
	if (error && object?.uuid) {
		// the batch holds the create: undoing it removes the half-made object everywhere
		import('./history').then((h) => h.undo?.()).catch(() => {});
		return { error };
	}
	return { object };
}

/**
 * TX5 Bake → mesh: an EXTRUDED text becomes a normal mesh (its geometry and its two materials,
 * editable vertices); the record is dropped. ONE undo step (undo brings the text back). Peers
 * get `textPath: null, bake: true` and bake their own build (applyRemoteBake), building it first
 * when they had not. The caller confirms first.
 * @param {string} uuid @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
export async function bakeTextToMesh(uuid) {
	const object = objectOf(uuid);
	if (!object?.userData?.textPath) return { ok: false, error: 'That is not a text object.' };
	const rec = normalizeTextPath(object.userData.textPath);
	if (rec.mode !== 'extruded' || !isBlockText(rec)) return { ok: false, error: 'Only solid (extruded) text bakes to a mesh. Switch it to Solid first.' };
	const m = await build3dModule();
	const geo = object.geometry;
	if (!geo || !m.ownsGeometry(geo) || !(geo.getAttribute?.('position')?.count > 0)) return { ok: false, error: 'The solid text is still being built — try again in a moment.' };
	bumpTextTurn(uuid);
	object.geometry = m.bakeCopy(geo);
	object.material = Array.isArray(object.material) ? object.material.map((/** @type {any} */ mt) => mt.clone()) : object.material;
	delete object.userData.textPath;
	const name = object.name;
	object.name = name === 'Text' ? 'Text mesh' : name;
	// the name rides the entry so an undo gives back "Text" (it read "Text mesh" in the licence warning after
	// an undo); `bake` makes a redo bake again
	recordEntry({ kind: 'props', uuid, before: { textPath: rec, name }, after: { textPath: null, bake: true, name: object.name } });
	/** @type {any} */
	const peer = get(peers);
	// every peer bakes its OWN build of the same record (§2 of the suite: identical triangles on two peers). The
	// mesh itself does not travel: a sign's toJSON is ~1 MB of plain number arrays, past what the peer
	// encoder packs (measured: "Maximum call stack size exceeded", nothing sent). `bake` is additive — an older
	// peer only drops the record
	peer?.send({ type: 'objectParameters', parameter: 'textPath', uuid, textPath: null, bake: true });
	pokeScene();
	return { ok: true };
}

/** text3dBuild once it has loaded: a bake that finds the solid already built then needs no await at all */
/** @type {any} */
let build3d = null;
const build3dModule = async () => (build3d ??= await import('./text3dBuild.js'));

/**
 * The receiving half of Bake, and a REDO of one on the writer: this peer's own extruded build of the
 * record becomes the mesh. A peer that has not built it yet (its font still arriving, a phone; or the
 * solid parked by an autosave export) builds it first at the desktop cap, so the baked mesh is the
 * writer's. Undo arrives as the record again and turns it back into a text.
 *
 * fix-bake: what cancels a bake that had to wait is a NEWER TURN of the record (`turn` is the one the
 * caller bumped, synchronously, when the bake message or the redo step arrived; an undo, a remote edit
 * or a local edit bumps it again) — never the record being REASSIGNED, which is how the 1.61 identity
 * guard left the writer's text standing while its peers baked. The object is looked up again by uuid
 * at the end (it may have been replaced under it), and its own solid, when it has one by then, is the
 * build that is baked.
 * @param {any} object @param {number=} turn the caller's bumpTextTurn(object.uuid); absent = bumped here
 */
export async function applyRemoteBake(object, turn) {
	const uuid = object?.uuid;
	if (!uuid || !object.userData?.textPath) return;
	const mine = turn ?? bumpTextTurn(uuid);
	const rec = normalizeTextPath(object.userData.textPath);
	const m = build3d ?? (await build3dModule());
	/** @type {any} */
	let geo = m.ownsGeometry(object.geometry) ? object.geometry : null;
	if (!geo && rec.mode === 'extruded' && isBlockText(rec)) {
		try {
			const rt = await import('./textPathRuntime.js');
			geo = (await m.buildExtruded(rec, await rt.solidFontUrl(rec), 'desktop')).geometry;
		} catch (error) {
			console.log('bake: could not build the text here', error);
		}
	}
	// a newer state of the record came after this bake (an undo raced it, an edit): leave the text alone
	if (textTurn(uuid) !== mine) return;
	const target = objectOf(uuid) ?? object;
	if (!target.userData?.textPath) return; // a mesh already
	if (m.ownsGeometry(target.geometry)) geo = target.geometry;
	const recNow = normalizeTextPath(target.userData.textPath);
	if (geo) {
		target.geometry = m.bakeCopy(geo);
		target.material =
			Array.isArray(target.material) && target.material.length === 2 ? target.material.map((/** @type {any} */ mt) => mt.clone()) : m.extrudedMaterials(recNow);
	}
	delete target.userData.textPath;
	if (target.name === 'Text') target.name = 'Text mesh';
	pokeScene();
}
