// @ts-ignore - no bundled three type declarations (project-wide)
import { get } from 'svelte/store';
import { objectsGroup, globalRenderer } from '../stores/sceneStore';
import { qualityOverrides } from './qualityGovernor';
import { lookTier, planTier, TIERED_FIELDS } from './materialTiersCore.js';
import { allLodTrees, onLodTreesChanged } from './lodTrees.js';

// 40 F16 — THE LOOK TIER, the runtime: walks the scene's physical materials and draws each one at
// this device's tier (materialTiersCore.js has the rule and the why). LOCAL: it writes the live
// material only, never a message, an undo entry or a preference.
//
// The AUTHORED numbers ride beside the material as `userData.lookTierAuthored` — written only
// when this device actually draws less than the author asked for, so a desktop save of an
// untouched scene stays byte-identical (a fresh stamp on every load would mark every scene
// dirty: the signature rule). userData travels with toJSON, the GLTF extras, the wire and undo,
// so a headset's save still restores the full look on a desktop, and a preset snapshot reads the
// record (materialPresetsCore.snapshotLook).

/** the tier pass's own writes, per material, so an edit made since is recognised @type {WeakMap<any, Record<string, number>>} */
const written = new WeakMap();
/** @type {'high'|'mid'|'low'} */
let tier = 'high';
/** a test/debug pin over the measured tier @type {'high'|'mid'|'low'|null} */
let pin = null;
let overrides = /** @type {any} */ ({});
let started = false;
/** @type {ReturnType<typeof setTimeout> | null} */
let pending = null;
let passes = 0;
let lowered = 0;

/** the tier for this device now */
function measure() {
	let xr = false;
	try {
		xr = !!(/** @type {any} */ (get(globalRenderer))?.xr?.isPresenting);
	} catch {
		/* a disposed renderer */
	}
	return lookTier({ xr, overrides, pin });
}

/**
 * Draw one material at a tier. Exported for the unit tests (a plain object with the fields works).
 * @param {any} material @param {'high'|'mid'|'low'} t @returns {boolean} whether anything is drawn lower than authored
 */
export function applyTierTo(material, t) {
	if (!material || !material.isMeshPhysicalMaterial) return false;
	/** @type {Record<string, number>} */
	const current = {};
	for (const f of TIERED_FIELDS) current[f] = typeof material[f] === 'number' ? material[f] : 0;
	const record = material.userData?.lookTierAuthored ?? null;
	const plan = planTier(current, record, written.get(material) ?? null, t);
	// the record exists once this device has drawn the look lower (and is kept current after)
	if (plan.lowers || record) {
		material.userData = material.userData ?? {};
		material.userData.lookTierAuthored = plan.authored;
	}
	let program = false;
	for (const f of TIERED_FIELDS) {
		const to = plan.draw[f];
		if (material[f] === to) continue;
		// three compiles transmission/sheen/iridescence in or out at zero: crossing it is a new program
		if (material[f] > 0 !== to > 0) program = true;
		material[f] = to;
	}
	if (program) material.needsUpdate = true;
	written.set(material, { ...plan.draw });
	return plan.lowers;
}

/** one pass over the scene */
export function applyMaterialTiers() {
	pending = null;
	tier = measure();
	const group = /** @type {any} */ (get(objectsGroup));
	if (!group?.traverse) return;
	passes++;
	let n = 0;
	/** @param {any} o */
	const visit = (o) => {
		if (!o.material) return;
		const list = Array.isArray(o.material) ? o.material : [o.material];
		for (const m of list) if (applyTierTo(m, tier)) n++;
	};
	group.traverse(visit);
	// 40 F14: the substitute models LOD groups draw at the scene root (a fallback group's real model)
	for (const tree of allLodTrees()) tree.traverse(visit);
	lowered = n;
}

function schedule() {
	if (pending) return;
	pending = setTimeout(applyMaterialTiers, 120);
}

/** boot: follow the scene, the governor and the headset */
export function startMaterialTiers() {
	if (started) return;
	started = true;
	objectsGroup.subscribe(schedule);
	onLodTreesChanged(schedule);
	qualityOverrides.subscribe((o) => {
		overrides = o ?? {};
		schedule();
	});
	// entering or leaving a headset is a tier change no store announces: look once a second
	setInterval(() => {
		if (measure() !== tier) schedule();
	}, 1000);
}

/** pin the tier (tests, a debug toggle); null follows the device again @param {'high'|'mid'|'low'|null} t */
export function pinMaterialTier(t) {
	pin = t === 'high' || t === 'mid' || t === 'low' ? t : null;
	applyMaterialTiers();
}

/** debug: the tier and what it lowered */
export function materialTiersDebug() {
	return { tier, pin, passes, lowered };
}
