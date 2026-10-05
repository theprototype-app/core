// 36-code (plan 75.5, SPIKE — behind a flag) — a code tab in its own browser window, for a
// second monitor. Off unless `localStorage['code:popout'] === 'true'` (or `setPopOut(true)`
// from the debug hook): quiz C5 says the user specs the wanted behaviour first, so this is
// the smallest thing that answers "does it work" and nothing more.
//
// THE SPIKE'S SHAPE: a same-origin `about:blank` popup shares this realm, so a CodeMirror
// view is mounted INTO the popup's document (`root` = that document — CodeMirror injects its
// styles there) and edits go through the ordinary `setTabCode` / `saveCodeTab`. Nothing is
// bridged because nothing needs to be. The productised version (a real route that survives
// the opener reloading, a BroadcastChannel carrying tab state) is roadmap-37 work once the
// behaviour is specced; the findings are in the 36-code handover.

import { writable, get } from 'svelte/store';
import { safeStorage } from './safeStorage';

export const popOutAvailable = writable(safeStorage.getItem('code:popout') === 'true');
/** @param {boolean} on */
export function setPopOut(on) {
	safeStorage.setItem('code:popout', String(!!on));
	popOutAvailable.set(!!on);
}

/** tab id -> the window showing it @type {Map<string, Window>} */
const windows = new Map();

/** @param {string} tabId @returns {Promise<Window | null>} */
export async function popOutCode(tabId) {
	if (!get(popOutAvailable) || typeof window === 'undefined') return null;
	const held = windows.get(tabId);
	if (held && !held.closed) {
		held.focus();
		return held;
	}
	const ws = await import('./codeWorkspace');
	const tab = ws.tabById(tabId);
	if (!tab) return null;
	const win = window.open('', 'tp-code-' + tabId, 'popup,width=820,height=620');
	if (!win) return null;
	windows.set(tabId, win);
	const doc = win.document;
	doc.title = tab.title + ' — ThePrototype code';
	doc.body.style.cssText = 'margin:0;height:100vh;display:flex;flex-direction:column;background:#111827;color:#e5e7eb;font:12px ui-sans-serif,system-ui';
	const bar = doc.createElement('div');
	bar.style.cssText = 'display:flex;gap:8px;align-items:center;padding:4px 8px;border-bottom:1px solid #374151';
	const title = doc.createElement('span');
	title.textContent = tab.title;
	const status = doc.createElement('span');
	status.style.cssText = 'margin-left:auto;opacity:.75';
	bar.append(title, status);
	const host = doc.createElement('div');
	host.style.cssText = 'flex:1;min-height:0;overflow:auto';
	doc.body.append(bar, host);

	const [{ EditorView, basicSetup }, { javascript }, view, state] = await Promise.all([
		import('codemirror'),
		import('@codemirror/lang-javascript'),
		import('@codemirror/view'),
		import('@codemirror/state')
	]);
	const save = () => {
		ws.saveCodeTab(tabId).then((r) => (status.textContent = r.ok ? 'saved' : 'not saved: ' + (r.error?.message ?? 'read-only')));
		return true;
	};
	const editor = new EditorView({
		doc: tab.code,
		parent: host,
		root: doc,
		extensions: [
			state.Prec.highest(view.keymap.of([{ key: 'Mod-s', preventDefault: true, run: save }])),
			basicSetup,
			javascript(),
			state.EditorState.readOnly.of(!!tab.readOnly),
			EditorView.updateListener.of((u) => {
				if (u.docChanged) ws.setTabCode(tabId, u.state.doc.toString());
			}),
			EditorView.theme({ '&': { height: '100%', backgroundColor: '#111827', color: '#e5e7eb' }, '.cm-gutters': { backgroundColor: '#1f2937', color: '#6b7280', border: 'none' } }, { dark: true })
		]
	});
	// the source moving under us (a save in the main window, a peer) shows here too
	const off = ws.codeTabs.subscribe((tabs) => {
		const t = tabs.find((x) => x.id === tabId);
		if (!t) return win.close();
		status.textContent = t.code !== t.saved ? 'unsaved' : '';
		if (t.code !== editor.state.doc.toString()) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: t.code } });
	});
	win.addEventListener('beforeunload', () => {
		off();
		editor.destroy();
		windows.delete(tabId);
	});
	return win;
}
