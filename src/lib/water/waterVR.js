// 36-water — the VR properties panel's Water rows: label · value · − / + (or press). Every
// edit goes through waterActions, so a headset edit replicates and undoes exactly like the
// desktop Inspector's. panels.js reaches this module through a PRIMED dynamic import (it
// pulls the history family through waterActions).
import { normalizeWater } from './volumes.js';
import { WATER_PRESETS, resolveLook, resolveBubbles } from './presets.js';
import { normalizeWaves } from './waves.js';
import {
	applyWaterPreset,
	updateObjectWater,
	makeWater,
	removeObjectWater
} from './waterActions.js';

/** rows shown for a water object (top to bottom, after the core rows) */
export const WATER_VR_ROWS = [
	'water:preset',
	'water:level',
	'water:waves',
	'water:clarity',
	'water:refraction',
	'water:foam',
	'water:caustics',
	'water:bubbles',
	'water:remove'
];
/** the one row a dry object gets */
export const WATER_VR_MAKE = 'water:make';

/** @param {any} object */
export function waterRowsFor(object) {
	return object?.userData?.water ? WATER_VR_ROWS : [WATER_VR_MAKE];
}

const LABELS = /** @type {Record<string, string>} */ ({
	'water:preset': 'Water',
	'water:level': 'Level',
	'water:waves': 'Waves',
	'water:clarity': 'Clarity',
	'water:refraction': 'Refraction',
	'water:foam': 'Foam',
	'water:caustics': 'Caustics',
	'water:bubbles': 'Bubbles',
	'water:remove': 'Remove water',
	'water:make': 'Make it water'
});

/** @param {string} row */
export function waterRowLabel(row) {
	return LABELS[row] ?? row;
}

/** rows that are a single press (no − / +) @param {string} row */
export function waterRowIsButton(row) {
	return row === 'water:remove' || row === 'water:make';
}

/** @param {any} object @param {string} row */
export function waterRowValue(object, row) {
	const raw = object?.userData?.water;
	if (!raw) return '';
	const w = normalizeWater(raw);
	const L = resolveLook(w);
	switch (row) {
		case 'water:preset':
			return (
				WATER_PRESETS.find((p) => p.key === w.preset)?.name ??
				(w.preset?.startsWith('user:') ? w.preset.slice(5) : 'custom')
			);
		case 'water:level':
			return w.level == null ? 'top' : w.level.toFixed(2);
		case 'water:waves':
			return normalizeWaves(w.waves).amplitude.toFixed(2) + ' m';
		case 'water:clarity':
			return Number(L.clarity).toFixed(1) + ' m';
		case 'water:refraction':
			return Number(L.refraction).toFixed(2);
		case 'water:foam':
			return Number(L.foam).toFixed(2);
		case 'water:caustics':
			return Number(L.caustics).toFixed(2);
		case 'water:bubbles':
			return resolveBubbles(w.bubbles).enabled ? 'on' : 'off';
	}
	return '';
}

/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * One − / + tick (sign -1 / 1) or a press (sign 1) on a water row.
 * @param {any} object @param {string} row @param {number} sign @returns {boolean} handled
 */
export function handleWaterRow(object, row, sign) {
	const uuid = object?.uuid;
	if (!uuid) return false;
	if (row === 'water:make') return !!makeWater(object, 'pool');
	const raw = object.userData.water;
	if (!raw) return false;
	const w = normalizeWater(raw);
	const L = resolveLook(w);
	const s = sign < 0 ? -1 : 1;
	switch (row) {
		case 'water:preset': {
			const at = Math.max(
				0,
				WATER_PRESETS.findIndex((p) => p.key === w.preset)
			);
			const next = WATER_PRESETS[(at + s + WATER_PRESETS.length) % WATER_PRESETS.length];
			return applyWaterPreset(uuid, next.key);
		}
		case 'water:level': {
			const cur = w.level ?? 0.5;
			return updateObjectWater(
				uuid,
				{ level: Math.round((cur + s * 0.05) * 100) / 100 },
				{ immediate: true }
			);
		}
		case 'water:waves': {
			const amp = normalizeWaves(w.waves).amplitude;
			const next = clamp(Math.round((amp + s * (amp < 0.1 ? 0.01 : 0.05)) * 1000) / 1000, 0, 2);
			const count = normalizeWaves(w.waves).count || 3;
			return updateObjectWater(uuid, { waves: { amplitude: next, count } }, { immediate: true });
		}
		case 'water:clarity':
			return updateObjectWater(
				uuid,
				{ look: { clarity: clamp(Number(L.clarity) * (s > 0 ? 1.25 : 0.8), 0.05, 40) } },
				{ immediate: true }
			);
		case 'water:refraction':
			return updateObjectWater(
				uuid,
				{ look: { refraction: clamp(Number(L.refraction) + s * 0.1, 0, 1.5) } },
				{ immediate: true }
			);
		case 'water:foam':
			return updateObjectWater(
				uuid,
				{ look: { foam: clamp(Number(L.foam) + s * 0.1, 0, 1) } },
				{ immediate: true }
			);
		case 'water:caustics':
			return updateObjectWater(
				uuid,
				{ look: { caustics: clamp(Number(L.caustics) + s * 0.1, 0, 2) } },
				{ immediate: true }
			);
		case 'water:bubbles':
			return updateObjectWater(
				uuid,
				{ bubbles: { enabled: !resolveBubbles(w.bubbles).enabled } },
				{ immediate: true }
			);
		case 'water:remove':
			return removeObjectWater(uuid);
	}
	return false;
}
