// 57 M5 — the MOTION PACK (packs repo `motion-kit`, Quaternius UAL, CC0): a list of humanoid `.tpanim`
// clips on the packs CDN. A clip enters the Explorer like any other clip file (deduped by hash), so
// the bytes travel once through the existing asset path. Loaded only when a tab, a dialog or the
// Locomotion preset asks for it.
import { PACKS_BASE } from '../packs';
import { fetchIndex } from '../contentBase';
import { clipForSlot } from './blendSpeed.js';

/** the packs CDN base, no trailing slash */
export const packBase = () => String(PACKS_BASE).replace(/\/+$/, '');
const base = () => packBase() + '/motion-kit/';

/** @type {Promise<any[]> | null} */
let list = null;

/**
 * The pack's clip list, memoized; a failed fetch is not remembered.
 * @param {boolean} [fresh] @returns {Promise<{name: string, file: string, duration: number, loop: boolean, bytes: number}[]>}
 */
export function motionClips(fresh = false) {
	if (!list || fresh) {
		list = fetchIndex(base() + 'clips.json')
			.then((res) => {
				if (!res.ok) throw new Error('the Motion pack list is unreachable (HTTP ' + res.status + ')');
				return res.json();
			})
			.catch((err) => {
				list = null;
				throw err;
			});
	}
	return list;
}

/** the group a clip is listed under @param {string} name */
export function motionGroup(name) {
	if (/walk|jog|sprint|run|crouch|idle|jump|fall|roll|slide|swim|climb/i.test(name)) return 'Move';
	if (/sword|pistol|punch|melee|shield|spell|hit|death|throw/i.test(name)) return 'Combat';
	return 'Actions';
}

/** The Asset Browser's rows + categories @param {boolean} [fresh] */
export async function motionRows(fresh = false) {
	const clips = await motionClips(fresh);
	const rows = clips.map((c) => ({
		source: 'motion',
		kind: 'motion',
		id: c.name,
		name: c.name,
		thumb: '',
		authors: ['Quaternius'],
		categories: [motionGroup(c.name)],
		tags: ['clip', 'animation', 'CC0'],
		licence: 'CC0-1.0',
		url: 'https://quaternius.com'
	}));
	const categories = ['Move', 'Combat', 'Actions'].map((id) => ({ id, label: id, count: rows.filter((r) => r.categories[0] === id).length }));
	return { rows, categories };
}

/**
 * Fetch one clip of the pack into the Explorer (the same bytes = the item already there).
 * @param {string} name @returns {Promise<any>} the Explorer item
 */
export async function addMotionClip(name) {
	const clip = (await motionClips()).find((c) => c.name === name);
	if (!clip) throw new Error(name + ' is not in the Motion pack');
	const res = await fetch(base() + clip.file);
	if (!res.ok) throw new Error(name + ' is unreachable (HTTP ' + res.status + ')');
	const { addItemFromBytes } = await import('../explorer');
	return addItemFromBytes(await res.arrayBuffer(), clip.name + '.tpanim');
}

/** a locomotion slot's pack clip and how a model's own clip name says it already fills that slot */
const LOCOMOTION = /** @type {const} */ ([
	['Idle_Loop', (/** @type {string[]} */ n) => !!clipForSlot(n, 'idle')],
	['Walk_Loop', (/** @type {string[]} */ n) => !!clipForSlot(n, 'walk')],
	['Jog_Fwd_Loop', (/** @type {string[]} */ n) => !!clipForSlot(n, 'run')],
	['Jump_Start', (/** @type {string[]} */ n) => n.some((c) => /jump|takeoff/i.test(c))],
	['Jump_Loop', (/** @type {string[]} */ n) => n.some((c) => /fall|jump_loop|jump_idle|airborne|in_air/i.test(c))]
]);

/** the pack clips a character with these clips lacks for the Locomotion preset @param {string[]} names */
export const missingLocomotion = (names) => LOCOMOTION.filter(([, has]) => !has(names)).map(([clip]) => clip);

/**
 * Give a humanoid the locomotion clips it lacks, from the pack (each one ref, its bytes sent once).
 * @param {string} uuid @param {string[]} names the clips it has
 * @returns {Promise<string[]>} every clip it has now
 */
export async function addLocomotionClips(uuid, names) {
	const { assignClipAsset } = await import('./clipAssets.js');
	const out = [...names];
	for (const clip of missingLocomotion(names)) {
		const item = await addMotionClip(clip);
		const name = item && assignClipAsset(uuid, item);
		if (name) out.push(name);
	}
	return out;
}
