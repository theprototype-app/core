<script>
	// Notebook tab strip for the bottom dock's Flow-family (Node editor / Flow Code /
	// Animation). Rendered at the top edge of each Flow-family docked panel; since only
	// the visible panel renders, only one strip shows. Clicking a tab activates it; the
	// "+" opens Flow Code / Animation / UV editor / Shader (docked). The Explorer is NOT here (it is a
	// separate, exclusive panel with no tabs).
	import { flowTabs, bottomDockActive, activateDock } from '$lib/bottomDock';
	import { flowCodeClose, animationClose, uvEditorClose, shaderEditorClose } from '../stores/appStore.js';
	import ContextMenu from './ContextMenu.svelte';

	let addMenu = $state(/** @type {{x:number,y:number}|null} */ (null));
	const addItems = [
		{ label: '＋ Flow Code', tooltip: 'Edit the graph as JSON', action: () => { flowCodeClose.set(false); activateDock('flowcode'); } },
		{ label: '＋ Animation', tooltip: 'Animate the selected object', action: () => { animationClose.set(false); activateDock('animation'); } },
		{ label: '＋ UV editor', tooltip: 'Edit the selected mesh’s UV map and textures', action: () => { uvEditorClose.set(false); activateDock('uv'); } },
		{ label: '＋ Shader', tooltip: 'Drive this material from a node graph', action: () => { shaderEditorClose.set(false); activateDock('shader'); } }
	];
	function openAdd(/** @type {MouseEvent} */ e) {
		const r = /** @type {HTMLElement} */ (e.currentTarget).getBoundingClientRect();
		addMenu = { x: r.left, y: r.bottom + 4 };
	}
</script>

<div class="absolute -top-6 left-3 z-20 flex gap-0.5">
	{#each $flowTabs as tab (tab.key)}
		<button
			class="tab-note px-4 pb-0.5 pt-1 text-xs font-semibold {$bottomDockActive === tab.key
				? 'bg-gray-700 text-white'
				: 'bg-gray-900/70 text-gray-400 hover:text-gray-200'}"
			onclick={() => activateDock(tab.key)}>{tab.title}</button
		>
	{/each}
	<button
		class="tab-note bg-gray-900/70 px-3 pb-0.5 pt-1 text-xs font-semibold text-gray-300 hover:text-white"
		title="Add a view (Flow Code, Animation, UV editor, Shader)"
		onclick={openAdd}>＋</button
	>
</div>

{#if addMenu}
	<ContextMenu x={addMenu.x} y={addMenu.y} items={addItems} on:close={() => (addMenu = null)} />
{/if}
