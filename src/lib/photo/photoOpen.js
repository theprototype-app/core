// Roadmap 98 P2 (lane 98-photo) — the two things the BOOT graph may know about Photo mode: is its window
// open, and its settings. A leaf (svelte/store + safeStorage), so the Look section's button and App's
// `{#if $photoOpen}` mount reach it without pulling photoMode / the tracer into the first load.
import { writable } from 'svelte/store';
import { safeStorage } from '$lib/safeStorage';

/** the Photo window is open (LOCAL) */
export const photoOpen = writable(false);

/** searchable words for the settings index / command palette */
export const photoKeywords = ['photo', 'render', 'path tracing', 'path traced', 'still', 'png', 'screenshot', 'raytrace', 'ray tracing', 'denoise', 'samples'];

const KEY = 'photo:prefs';
/** @returns {{samples: number, seconds: number, denoise: boolean, scale: number, force: boolean}} */
function readPrefs() {
	const d = { samples: 256, seconds: 60, denoise: true, scale: 1, force: false };
	try {
		const raw = JSON.parse(safeStorage.getItem(KEY) ?? 'null');
		if (raw && typeof raw === 'object') {
			if (Number.isFinite(raw.samples)) d.samples = raw.samples;
			if (Number.isFinite(raw.seconds)) d.seconds = raw.seconds;
			if (typeof raw.denoise === 'boolean') d.denoise = raw.denoise;
			if ([0.5, 1, 2].includes(raw.scale)) d.scale = raw.scale;
		}
	} catch {
		/* a bad stored value: the defaults */
	}
	return d;
}

/** the Photo window's settings (LOCAL, persisted; `force` = "try here anyway" on a phone, never persisted) */
export const photoPrefs = writable(readPrefs());
photoPrefs.subscribe((p) => {
	try {
		safeStorage.setItem(KEY, JSON.stringify({ samples: p.samples, seconds: p.seconds, denoise: p.denoise, scale: p.scale }));
	} catch {
		/* storage off: the session keeps them */
	}
});

/** open the Photo window */
export function openPhoto() {
	photoOpen.set(true);
}
