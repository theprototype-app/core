<script>
	// A5 — renders one ToolboxWindow per OPEN module toolbox.
	//
	// The module supplies a `(el) => cleanup` mount fn and writes plain DOM into the
	// node; everything around it (header drag, width grip + persistence, focusStack
	// z-banding, the <=640px bottom sheet, the `.tbx-*` styling contract) comes from the
	// shared shell. That is the whole point of the seam: a module gets the app's own
	// tool-palette treatment without shipping a line of chrome.
	//
	// Keyed by id so re-registering a toolbox (dev live reload) re-runs cloudMount's
	// update path rather than leaving the previous module's DOM behind.
	import ToolboxWindow from './ToolboxWindow.svelte';
	import { cloudMount } from '$lib/cloudMount';
	import { moduleToolboxes, openToolboxes, closeModuleToolbox } from '$lib/moduleToolboxes';
	import { isLocked } from '../../stores/sceneStore';
	import { X } from '@lucide/svelte';

	// A module toolbox CAN close itself, unlike the mesh/sculpt ones — it belongs to no
	// edit session, so the ✕ is the only way out and has to be there.
	//
	// `playMode` defaults to FALSE: a tool palette over a game is in the way unless the
	// module says otherwise (Towers' host settings do, a generator's controls do not).
	const shown = $derived(
		$moduleToolboxes.filter((b) => $openToolboxes.includes(b.id) && (!$isLocked || b.playMode))
	);
</script>

{#each shown as box (box.id)}
	<ToolboxWindow
		id={box.id}
		title={box.title}
		key={box.key ?? box.id}
		width={box.width ?? 220}
		minW={box.minW ?? 160}
		defaultRect={box.defaultRect ?? { right: 12, top: 76 }}
	>
		{#snippet actions()}
			<button
				class="tbx-hbtn"
				title="Close"
				aria-label="Close {box.title}"
				onclick={() => closeModuleToolbox(box.id)}
			>
				<X size={14} aria-hidden="true" />
			</button>
		{/snippet}
		<div class="mod-tbx-mount" use:cloudMount={box.mount}></div>
	</ToolboxWindow>
{/each}

<style>
	/* The mount node spans the toolbox body's grid, which is an auto-fill of fixed
	   square cells — without this a module's own markup becomes ONE cell and every
	   control it writes is clipped to 36px (the ToolboxSection lesson, one level out). */
	.mod-tbx-mount {
		grid-column: 1 / -1;
		display: flex;
		width: 100%;
		flex-direction: column;
		gap: 4px;
	}
</style>
