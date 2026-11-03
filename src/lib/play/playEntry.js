// 94 SP1 — THE PLAY ENTRY FLAG. A LEAF (reads `location` once, imports nothing).
//
// `/play` (src/routes/play) is a second page of the SAME build that boots only what a player
// needs: the viewport, the scene, physics, the flow / behaviour runtime, the play HUD, input and
// the peer layer — no editor panels, Inspector, Explorer, node editor, AI window or settings UI.
// It runs the editor's own runtime modules (no fork); what differs is which ones its root
// component (src/PlayApp.svelte) imports and starts, so the editor's code never enters its boot.
//
// Read ONCE at module evaluation, the way playMode reads `?embed=1` and exportBoot reads
// `window.__TP_EXPORT__`: everything that asks "am I the play entry?" agrees for the page's life.
// The prerender (no `location`) answers false.
//
// URL contract (agreed with 94-routes, cloud worker-community): `/play?s=<id>&src=play|embed&b=v<n>`
// on PLAY_ORIGIN or the app origin; `?scene=<https .tpscene URL>` for a scene that is not a
// community record; an invite hash `#<host>[~srv]&invite=<token>` joins exactly as in the app.

function readPlayEntry() {
	try {
		if (typeof location === 'undefined') return false;
		return /^\/play(?:\/|\.html)?$/.test(location.pathname);
	} catch {
		return false;
	}
}

/** true for the whole life of a page opened at `/play` */
export const playEntry = readPlayEntry();

/**
 * `?scene=<url>` — a .tpscene to play that is not a community record (docs mini-scenes, a
 * template). https only (http on localhost for development); anything else is ignored.
 * @returns {string}
 */
export function playEntrySceneUrl() {
	try {
		if (!playEntry) return '';
		const raw = new URLSearchParams(location.search).get('scene') || '';
		if (!raw) return '';
		const u = new URL(raw, location.href);
		const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
		if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return '';
		return u.href;
	} catch {
		return '';
	}
}
