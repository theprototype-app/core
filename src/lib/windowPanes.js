// 107-panels — a WINDOW'S OWN SIDEBARS, reachable from outside the window (a LEAF: imports nothing). Every
// WindowShell (the Explorer, the UV / HUD / Timeline / Profiler editors, the Image editor) keeps its primary and
// secondary pane state inside the component; each one registers here while it is mounted, so the assistant's
// show {state: "collapse" | "expand", pane} works the window's own handles, never a copy of their state.

/**
 * @typedef {{
 *   status: () => {primary: {available: boolean, open: boolean}, secondary: {available: boolean, open: boolean, mode: string}, locked: boolean, narrow: boolean},
 *   setPrimary: (open: boolean) => void,
 *   setSecondary: (open: boolean) => void
 * }} PanesApi
 */

/** window key -> the newest mounted shell's panes @type {Map<string, PanesApi>} */
const shells = new Map();

/** a mounted WindowShell registers its panes @param {string} key @param {PanesApi} api @returns {() => void} unregister */
export function registerPanes(key, api) {
	shells.set(key, api);
	return () => {
		if (shells.get(key) === api) shells.delete(key);
	};
}

/** the panes of the window with this key, or null while it is not mounted @param {string} key */
export function panesOf(key) {
	return shells.get(key) ?? null;
}
