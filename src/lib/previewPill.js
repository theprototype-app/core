// 103 H11 — THE PREVIEW PILL's boot half (a leaf: stores + the chrome-button registry). The pill itself
// (src/components/preview/PreviewPill.svelte: "Preview" + one part per judged device + the chevron menu),
// its menu and the phone drawer are LAZY; Menu.svelte mounts them.
//
// One control, one cluster: the pill is the `budget` cluster of Edit positions (its record key predates the
// merge, so a placed or hidden 46 B1 budget chip keeps its place), and the `top.preview` chrome button, so
// right-click / a long press on it offers Hide this button, Show buttons and Customize buttons. Its listed
// name is "Preview and budget".
import { writable, derived } from 'svelte/store';
import { registerChromeButton } from './chromeButtons.js';
import { toolbarSlots, patchCluster } from './toolbarSlots.js';

/** the phone drawer (Draw as, Quality, Cinematic view where offered) — a toolbar item opens it */
export const previewDrawerOpen = writable(false);

/** asks the pill to open its menu (Configure scene ▸ View's link row: one home per setting); a counter, so
 *  every press is a fresh ask @type {import('svelte/store').Writable<number>} */
export const previewMenuAsk = writable(0);
export const openPreviewMenu = () => previewMenuAsk.update((n) => n + 1);

/** hidden = the cluster's own `hidden`, outside Edit positions (inside it the pill is drawn faint) */
const hidden = derived(toolbarSlots, (s) => !!s.clusters?.budget?.hidden && !s.editing);

registerChromeButton({
	id: 'top.preview',
	kind: 'top',
	label: 'Preview and budget',
	icon: 'eye',
	state: { hidden, set: (h) => patchCluster('budget', { hidden: h }) }
});
