// 69 T4 — AN OPTIONAL SECOND ORIGIN FOR PLAYING. A LEAF (reads only build env and `location`).
//
// The editor's origin holds what a person signs in with and what they have made (the login token,
// AI keys, autosaves). A shared game does not need any of it, so a hosted deployment can serve the
// SAME build from a second origin — `VITE_PLAY_ORIGIN`, e.g. https://play.theprototype.app — and
// point play links and embeds there: storage is per origin, so whatever runs in a played scene
// finds nothing of the editor's on the page it runs in.
//
// Unset (the default, and every self-hosted `npm run dev`) means one origin for everything, exactly
// as before. On the play origin the page is player-only for its whole life (embed chrome, no editor)
// and the cloud plugin is told so (`cloudApi.playOrigin`) so it never asks anyone to sign in there.
//   VITE_PLAY_ORIGIN   where play / embed links point (an origin; a path is ignored)
//   VITE_APP_ORIGIN    the editor's origin, for the play origin's "open in the app" link
//                      (unset: the link stays on the play origin's own root)

/** the origin of an absolute http(s) URL, else '' @param {unknown} url */
export function originOf(url) {
	try {
		const u = new URL(String(url ?? ''));
		return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : '';
	} catch {
		return '';
	}
}

// 54 X7: literal keys, never the whole env object (vite inlines that object into the chunk)
/** the configured play origin ('' = none: play happens where the app is) */
export const PLAY_ORIGIN = originOf(import.meta.env.VITE_PLAY_ORIGIN);
/** the configured editor origin ('' = unknown) */
export const APP_ORIGIN = originOf(import.meta.env.VITE_APP_ORIGIN);

const here = typeof location !== 'undefined' ? location.origin : '';

/** true when THIS page is served from the separate play origin */
export const onPlayOrigin = !!PLAY_ORIGIN && here === PLAY_ORIGIN && PLAY_ORIGIN !== APP_ORIGIN;

/** An absolute URL on the play origin (this origin when none is configured). @param {string} path e.g. `/?s=<id>&play=1` */
export function playUrl(path) {
	return (PLAY_ORIGIN || here) + (path.startsWith('/') ? path : '/' + path);
}

/** A URL in the editor: absolute to VITE_APP_ORIGIN from the play origin, else a plain path. @param {string} path */
export function appUrl(path) {
	const p = path.startsWith('/') ? path : '/' + path;
	return onPlayOrigin && APP_ORIGIN ? APP_ORIGIN + p : p;
}
