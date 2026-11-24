// 103 H7 — Settings ▸ Gizmo ▸ Show: per style, the handle kinds switched off. LAZY (the faces and the
// Settings card import it, never the boot): a LOCAL pref, like the rest of $lib/gizmo/gizmoPrefs.
import { writable } from 'svelte/store';
import { safeStorage } from '../safeStorage';

/** the handle kinds each style can switch off ("show only") */
export const STYLE_KINDS = {
	B: ['arrows', 'planes', 'rings', 'cubes', 'knob'],
	C: ['disc', 'lift', 'ring', 'knob'],
	D: ['corners', 'faces', 'arc']
};

/** @returns {Record<string, string[]>} */
function loadHide() {
	try {
		const raw = typeof localStorage !== 'undefined' ? safeStorage.getItem('gizmoHide') : null;
		const v = raw ? JSON.parse(raw) : null;
		/** @type {Record<string, string[]>} */
		const out = {};
		for (const s of Object.keys(STYLE_KINDS)) {
			const list = Array.isArray(v?.[s]) ? v[s].filter((/** @type {any} */ k) => STYLE_KINDS[/** @type {'B'} */ (s)].includes(k)) : [];
			if (list.length) out[s] = list;
		}
		return out;
	} catch {
		return {};
	}
}
/** @type {import('svelte/store').Writable<Record<string, string[]>>} */
export const gizmoHide = writable(loadHide());
gizmoHide.subscribe((value) => {
	try {
		if (typeof localStorage === 'undefined') return;
		if (!Object.keys(value).length) safeStorage.removeItem('gizmoHide');
		else safeStorage.setItem('gizmoHide', JSON.stringify(value));
	} catch {
		/* private mode */
	}
});

/** @param {string} style @param {string} kind @param {boolean} shown */
export function setKindShown(style, kind, shown) {
	gizmoHide.update((all) => {
		const list = new Set(all[style] ?? []);
		if (shown) list.delete(kind);
		else list.add(kind);
		const next = { ...all };
		if (list.size) next[style] = [...list];
		else delete next[style];
		return next;
	});
}

