<script lang="ts">
	import { nodeCatalog } from '$lib/nodeCatalog';
	import { moduleNodeGroups } from '$lib/moduleSDK';
	import { customNodeDefs } from '../../stores/flowStore';

	// tap/click adds the node (touch has no HTML5 drag); Nodes.svelte places it at
	// the pane centre. A real drag fires no click, so desktop drag is unaffected.
	export let onPick: (type: string) => void = () => {};
	// touch drag-to-place: place the node at a screen point when a touch drag drops
	// onto the flow pane (desktop keeps using native HTML5 drag -> onDrop).
	export let onPlaceAt: (type: string, clientX: number, clientY: number) => void = () => {};

	const onDragStart = (event: DragEvent, nodeType: string) => {
		if (!event.dataTransfer) {
			return null;
		}
		event.dataTransfer.setData('application/svelteflow', nodeType);
		event.dataTransfer.effectAllowed = 'move';
	};

	// --- touch drag: HTML5 DnD is desktop-only, so on touch a HORIZONTAL-dominant
	// drag (vertical stays palette scroll via touch-action: pan-y) drags a ghost to
	// the canvas and drops it there. A plain tap still fires onPick (add at centre). ---
	let dragType: string | null = null;
	let dragging = false;
	let ghostLabel = '';
	let ghostX = 0;
	let ghostY = 0;
	let startX = 0;
	let startY = 0;
	let suppressClick = false;

	function onItemPointerDown(e: PointerEvent, type: string, label: string) {
		if (e.pointerType === 'mouse') return; // desktop uses native HTML5 drag
		dragType = type;
		ghostLabel = label;
		startX = e.clientX;
		startY = e.clientY;
		dragging = false;
		suppressClick = false;
	}
	function onItemPointerMove(e: PointerEvent) {
		if (dragType == null || e.pointerType === 'mouse') return;
		const dx = e.clientX - startX;
		const dy = e.clientY - startY;
		if (!dragging) {
			if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
				dragging = true;
				try {
					(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
				} catch {}
			} else if (Math.abs(dy) > 10) {
				dragType = null; // vertical -> let the palette scroll
			}
			if (!dragging) return;
		}
		e.preventDefault();
		ghostX = e.clientX;
		ghostY = e.clientY;
	}
	function onItemPointerUp(e: PointerEvent) {
		if (dragging && dragType) {
			const overPane = document.elementFromPoint(e.clientX, e.clientY)?.closest('.svelte-flow');
			if (overPane) onPlaceAt(dragType, e.clientX, e.clientY);
			suppressClick = true; // a drag must not also fire the tap-add
		}
		dragging = false;
		dragType = null;
	}
	function onItemClick(type: string) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		onPick(type);
	}

	let filter = '';

	$: catalog = [
		...nodeCatalog,
		...$moduleNodeGroups,
		...($customNodeDefs.length > 0
			? [
					{
						group: 'Custom',
						items: $customNodeDefs.map((def) => ({ type: 'customnode:' + def.id, label: def.name }))
					}
				]
			: [])
	]
		.map((group) => ({
			...group,
			items: group.items.filter(
				(item) =>
					!filter.trim() ||
					(item.label + ' ' + item.type + ' ' + group.group)
						.toLowerCase()
						.includes(filter.trim().toLowerCase())
			)
		}))
		.filter((group) => group.items.length > 0);
</script>

<aside class="flex flex-col gap-2 p-2">
	<input
		id="palette-filter"
		class="rounded border border-gray-300 bg-transparent px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-600 dark:text-gray-200"
		placeholder="Filter nodes…"
		bind:value={filter}
	/>
	<p class="text-center text-xs italic text-gray-400">Drag a node to the canvas, or tap to add it</p>
	{#each catalog as group}
		<p class="mt-1 text-xs font-semibold uppercase text-gray-400">{group.group}</p>
		{#each group.items as node}
			<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
			<div
				class="touch-pan-y cursor-grab rounded-2xl border border-solid border-gray-200 bg-white/70 shadow-[0_7px_9px_0_rgba(0,0,0,0.02)]"
				role="listitem"
				on:dragstart={(event) => onDragStart(event, node.type)}
				on:pointerdown={(event) => onItemPointerDown(event, node.type, node.label)}
				on:pointermove={onItemPointerMove}
				on:pointerup={onItemPointerUp}
				on:click={() => onItemClick(node.type)}
				draggable={true}
			>
				<div
					class="family-mono rounded-2xl px-3 py-2 text-center font-mono text-xs font-semibold text-[#0F172A] dark:bg-gray-700 dark:text-gray-200"
				>
					{node.label}
				</div>
			</div>
		{/each}
	{/each}
</aside>

<!-- drag ghost that follows the finger while touch-dragging a node onto the canvas -->
{#if dragging}
	<div
		class="pointer-events-none fixed z-[1400] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-primary-400 bg-gray-800 px-3 py-2 text-center font-mono text-xs font-semibold text-gray-100 shadow-lg"
		style="left: {ghostX}px; top: {ghostY}px;"
	>
		{ghostLabel}
	</div>
{/if}
