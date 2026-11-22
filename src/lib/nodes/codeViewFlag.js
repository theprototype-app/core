// 2.0 N2 — the `codeView` FLAG: the read-only code view (the Nodes editor's Code tab, the phone/VR
// sheet, and the agent's `code` field). ON BY DEFAULT since 1.71 (2.0-int: the Quest flow-tick bench inside
// the base spread, the view opens on every template, a late joiner's view matches); switched off per browser
// with `localStorage['flag:codeView'] = '0'` (or `codeViewFlag.set(false)` from the debug stores).
// LOCAL, never replicated: it only changes what this tab SHOWS — the graph, the wire and the tick are
// the same either way.
import { writable, get } from 'svelte/store';
import { safeStorage } from '../safeStorage';

export const CODE_VIEW_KEY = 'flag:codeView';

/** @returns {boolean} */
function read() {
	const v = safeStorage.getItem(CODE_VIEW_KEY);
	return !(v === '0' || v === 'false'); // absent = on, the default
}

export const codeViewFlag = writable(read());
codeViewFlag.subscribe((on) => {
	if (on) safeStorage.removeItem(CODE_VIEW_KEY); // absent = on, the default
	else safeStorage.setItem(CODE_VIEW_KEY, '0');
});

/** for code outside components (the agent tools) */
export const codeViewOn = () => get(codeViewFlag);
