// 2.0 N2 — the `codeView` FLAG: the read-only code view (the Nodes editor's Code tab, the phone/VR
// sheet, and the agent's `code` field) ships OFF and is switched on per browser with
// `localStorage['flag:codeView'] = '1'` (or `codeViewFlag.set(true)` from the debug stores).
// LOCAL, never replicated: it only changes what this tab SHOWS — the graph, the wire and the tick are
// the same either way. Removed (with every check of it) once it is on by default.
import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';

export const CODE_VIEW_KEY = 'flag:codeView';

/** @returns {boolean} */
function read() {
	const v = safeStorage.getItem(CODE_VIEW_KEY);
	return v === '1' || v === 'true';
}

export const codeViewFlag = writable(read());
codeViewFlag.subscribe((on) => {
	if (on) safeStorage.setItem(CODE_VIEW_KEY, '1');
	else safeStorage.removeItem(CODE_VIEW_KEY); // absent = off, the default
});

/** for code outside components (the agent tools) */
export const codeViewOn = () => get(codeViewFlag);
