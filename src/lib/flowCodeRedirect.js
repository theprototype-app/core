import { get } from 'svelte/store';
import { flowCodeClose } from '../stores/appStore.js';
import { activeGraphId } from '../stores/flowStore';

// showhide-v8 §4 (owner 2026-11-09) — FLOW CODE IS NO LONGER ITS OWN TAB. The graph text it edited is a tab of
// the Code window now (the "flow code" entry under each graph in Code's file tree, beside graph.json; Ctrl+S
// applies). `flowCodeClose` stays as the seam every old way in still writes — the Alt+F shortcut, togglePanel,
// a saved layout or a named workspace that names the old tab — and opening it opens Code on the active graph's
// flow code instead, then closes the old store again so nothing waits on a panel that is not mounted.

let started = false;

export function startFlowCodeRedirect() {
	if (started) return;
	started = true;
	flowCodeClose.subscribe((closed) => {
		if (closed) return;
		queueMicrotask(() => flowCodeClose.set(true));
		const graphId = get(activeGraphId) || 'scene';
		import('./codeWorkspace')
			.then((m) => m.openCode({ source: 'flowtext', ref: { graphId } }))
			.catch(() => {});
	});
}
