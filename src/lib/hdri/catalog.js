// 37-hdri — the bundled HDRIs (static/hdri/, CC0 from Poly Haven — static/hdri/CREDITS.md).
// A leaf: no imports, so environment.js, the scene lint and the UI can all read it.
//
// `sun` is the direction of the brightest spot above the horizon at rotation 0, in three's
// world frame (scripts/hdri-bake.cjs prints it), which is where each HDRI preset puts its rig
// sun so the shadows agree with the sky. The flat colours in the presets (environment.js) come
// from the same bake — they are what an older peer, which ignores `hdri`, shows instead.

/** @type {Record<string, {label: string, file: string, card: string, credit: string, sun: number[]}>} */
export const BUNDLED_HDRIS = {
	clearsky: {
		label: 'Clear sky',
		file: 'hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr',
		card: 'hdri/clearsky.png',
		credit: 'Kloofendal 48d Partly Cloudy (Pure Sky) — Greg Zaal, Jarod Guest (Poly Haven, CC0)',
		sun: [0.553, 0.743, 0.377]
	},
	meadow: {
		label: 'Meadow',
		file: 'hdri/meadow_2_1k.hdr',
		card: 'hdri/meadow.png',
		credit: 'Meadow 2 — Sergej Majboroda (Poly Haven, CC0)',
		sun: [0.721, 0.452, 0.525]
	},
	sunrise: {
		label: 'Sunrise',
		file: 'hdri/spruit_sunrise_1k.hdr',
		card: 'hdri/sunrise.png',
		credit: 'Spruit Sunrise — Greg Zaal (Poly Haven, CC0)',
		sun: [0.805, 0.138, 0.578]
	},
	starlight: {
		label: 'Starlight',
		file: 'hdri/dikhololo_night_1k.hdr',
		card: 'hdri/starlight.png',
		credit: 'Dikhololo Night — Greg Zaal (Poly Haven, CC0)',
		sun: [-0.45, 0.85, -0.3]
	},
	photostudio: {
		label: 'Photo studio',
		file: 'hdri/studio_small_09_1k.hdr',
		card: 'hdri/photostudio.png',
		credit: 'Studio Small 09 — Sergej Majboroda (Poly Haven, CC0)',
		sun: [-0.821, 0.258, -0.509]
	}
};

/** 'bundled:meadow' -> its catalog row, else null @param {string} src */
export function bundledHdri(src) {
	const m = /^bundled:(.+)$/.exec(String(src ?? ''));
	return (m && BUNDLED_HDRIS[m[1]]) || null;
}
