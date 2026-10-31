// 52 — the VR build-tool radial entries: Tools ▸ Measure + the Measure ring (V1), Selected ▸ Edit measurement,
// Selected ▸ Arrange (V2: one ring — Axis · Align min / centre / max · Even centres / gaps · Drop · Align to). vrRadialMenu calls these from its
// registerBuiltins with its own `registerVRMenuEntry` (handed in, not imported: this file is reached from
// vrRadialMenu, and an import back would close a cycle). The tools themselves load on first use (dynamic
// imports): the measure runtime and align.js sit in history's family, which the radial must not pull in eagerly.
import { get, writable } from 'svelte/store';
import { selectedObjects, selectedObject, vrToolMode } from '../../stores/sceneStore';
import { ALIGN_EDGES, DISTRIBUTE_MODES, arrangeCall, arrangeMinimum, sectorOp, nextAxis } from './arrangeCore.js';

/** the Arrange ring's "Align to" switch — LOCAL, the Inspector Arrange section's Selection / Active */
export const vrAlignToActive = writable(false);
/** the Arrange ring's axis (its Axis sector cycles it) — LOCAL */
export const vrArrangeAxis = writable('x');

const selCount = () => /** @type {string[]} */ (get(selectedObjects))?.length ?? 0;
const vrMeasure = () => import('./measure.js');
const measureOn = () => get(vrToolMode) === 'measure';
/** is the (single) selection a kept measurement? (measureItems.isMeasurement, read inline — no import) */
const measurementSelected = () => selCount() === 1 && Array.isArray(/** @type {any} */ (get(selectedObject))?.userData?.measure?.points);

/**
 * Run an arrange op: the SAME align.js call the desktop makes (arrangeCore.arrangeCall). Takes a ring
 * sector (`arrange:min` … on the ring's axis) or a canonical op id (`align:x:min`).
 * @param {string} id @returns {Promise<number>} objects moved
 */
export async function runArrange(id) {
	const op = id.startsWith('arrange:') ? sectorOp(id, get(vrArrangeAxis)) : id;
	const call = op ? arrangeCall(op, get(vrAlignToActive)) : null;
	if (!call) return 0;
	const align = /** @type {any} */ (await import('../align'));
	return align[call.fn](...call.args);
}

/** @param {(entry: any) => void} register vrRadialMenu.registerVRMenuEntry */
export function registerMeasureRings(register) {
	// Tools ▸ Measure — a trigger tool beside Select / Box select / Draw
	register({
		id: 'measure:tool',
		group: 'tools',
		label: 'Measure',
		icon: 'ruler',
		order: 2.5,
		closes: true,
		active: measureOn,
		action: () => void vrMeasure().then((m) => (measureOn() ? m.stopVRMeasure() : m.startVRMeasure()))
	});
	// the Measure ring — the radial opens on it while the tool is up (vr/measure.js)
	register({
		id: 'measure:keep',
		group: 'measure',
		label: 'Keep',
		icon: 'check',
		order: 0,
		closes: true,
		action: () => void vrMeasure().then((m) => m.vrKeepMeasurement())
	});
	register({
		id: 'measure:undo',
		group: 'measure',
		label: 'Undo point',
		icon: 'undo-2',
		order: 1,
		action: () => void vrMeasure().then((m) => m.vrUndoMeasurePoint())
	});
	register({
		id: 'measure:discard',
		group: 'measure',
		label: 'Discard',
		icon: 'trash-2',
		order: 2,
		closes: true,
		action: () => void vrMeasure().then((m) => m.vrDiscardMeasurement())
	});
	register({
		id: 'measure:snap',
		group: 'measure',
		label: 'Snap',
		icon: 'magnet',
		order: 3,
		active: () => measureSnapOn,
		action: () => void import('../measure').then((m) => m.measureSnap.update((on) => !on))
	});
	register({
		id: 'measure:done',
		group: 'measure',
		label: 'Done',
		icon: 'circle-check',
		order: 4,
		closes: true,
		action: () => void vrMeasure().then((m) => m.stopVRMeasure())
	});
	// Selected ▸ Edit measurement — a kept measurement's points from the headset (the desktop's Tab)
	register({
		id: 'obj:editmeasure',
		group: 'object',
		label: 'Edit measurement',
		icon: 'ruler',
		order: 1,
		closes: true,
		visible: measurementSelected,
		action: () => {
			const uuid = /** @type {any} */ (get(selectedObject))?.uuid;
			if (uuid) void vrMeasure().then((m) => m.editVRMeasurement(uuid));
		}
	});
}

/** the Snap sector's dot reads this (the measure module loads lazily, so its store is mirrored once loaded) */
let measureSnapOn = true;
void (typeof window !== 'undefined' &&
	import('../measure').then((m) => m.measureSnap.subscribe((on) => (measureSnapOn = !!on))).catch(() => {}));

/** @param {(entry: any) => void} register vrRadialMenu.registerVRMenuEntry */
export function registerArrangeRings(register) {
	const tooFew = (/** @type {string} */ id) => () => selCount() < arrangeMinimum(id);
	const AX = () => get(vrArrangeAxis).toUpperCase();
	// Selected ▸ Arrange — a multi-selection's (the desktop's Arrange section is the multi-select Inspector's)
	register({ id: 'nav:arrange', group: 'object', label: 'Arrange', icon: 'align-start-vertical', order: 4.5, ring: 'arrange', visible: () => selCount() > 1 });
	// one ring, the radial's two-level rule: the Axis sector picks X / Y / Z, every other sector acts on it
	register({
		id: 'arrange:axis',
		group: 'arrange',
		label: 'Axis',
		icon: 'move',
		order: 0,
		value: AX,
		action: () => vrArrangeAxis.update(nextAxis)
	});
	ALIGN_EDGES.forEach((e, i) =>
		register({
			id: `arrange:${e.edge}`,
			group: 'arrange',
			label: () => `Align ${AX()} ${e.label.toLowerCase()}`,
			icon: e.icon,
			order: 1 + i,
			closes: true,
			disabled: tooFew(`arrange:${e.edge}`),
			action: () => void runArrange(`arrange:${e.edge}`)
		})
	);
	DISTRIBUTE_MODES.forEach((m, i) =>
		register({
			id: `arrange:${m.mode}`,
			group: 'arrange',
			label: () => `${AX()} even ${m.label}`,
			icon: 'align-horizontal-space-around',
			order: 4 + i,
			closes: true,
			disabled: tooFew(`arrange:${m.mode}`),
			action: () => void runArrange(`arrange:${m.mode}`)
		})
	);
	register({
		id: 'arrange:drop',
		group: 'arrange',
		label: 'Drop to ground',
		icon: 'arrow-down-to-line',
		order: 6,
		closes: true,
		action: () => void runArrange('arrange:drop')
	});
	register({
		id: 'arrange:to',
		group: 'arrange',
		label: 'Align to',
		icon: 'crosshair',
		order: 7,
		value: () => (get(vrAlignToActive) ? 'Active' : 'Selection'),
		action: () => vrAlignToActive.update((v) => !v)
	});
}
