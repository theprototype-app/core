<script>
	// 64-2d D6: THE 2D TOOLBAR — while the flat 2D view is on (and not playing) this rail stands in
	// for the 3D toolbox (the bottom bar's move / rotate / scale / pivot step aside: Controls). The
	// tools are DATA ($lib/sprite2d/tools2d.js): select, text and layers are built in; pen, shapes
	// and extrude come from the features that ship them (a `tools2d.js` beside their code), so a
	// build without them has no such button — never a dead one. "Back to 3D" leaves the view.
	// LOCAL: which tool is armed is a fact about this screen; what a tool MAKES replicates as usual.
	import { onDestroy, onMount, untrack } from 'svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import Icon from '../ui/Icon.svelte';
	import Layers2dPanel from './Layers2dPanel.svelte';
	import { exit2dView } from '$lib/sprite2d/view2d.js';
	import { loadTools, toolContext, layersOpen } from '$lib/sprite2d/tools2d.js';

	/** @type {import('$lib/sprite2d/tools2d.js').Tool2d[]} */
	let tools = $state([]);
	/** the tool last pressed (lights when it has no `active` store of its own and is not one-shot) */
	let last = $state('select');
	/** each tool's `active` store, read into one map (a $store cannot be read inside an each) */
	/** @type {Record<string, boolean>} */
	let actives = $state({});
	$effect(() => {
		// a store calls back AT ONCE inside subscribe: reading `actives` there would make this effect depend on
		// what it writes (an update loop), so the write reads it untracked
		const subs = tools.filter((t) => t.active).map((t) => /** @type {any} */ (t.active).subscribe((/** @type {boolean} */ v) => (actives = { ...untrack(() => actives), [t.id]: !!v })));
		return () => subs.forEach((u) => u());
	});

	onMount(() => {
		void loadTools().then((list) => (tools = list));
	});

	/** ask every armed tool to stand down (another one was pressed, or the view closes) @param {string} [except] */
	function disarm(except) {
		for (const t of tools) if (t.id !== except) t.disarm?.();
	}

	/** @param {import('$lib/sprite2d/tools2d.js').Tool2d} tool */
	async function press(tool) {
		const ctx = toolContext({ disarm: () => disarm(tool.id), exit: back });
		last = tool.id;
		try {
			await tool.run(ctx);
		} catch (error) {
			console.warn('2D tool failed', tool.id, error);
		}
	}

	function back() {
		disarm();
		layersOpen.set(false);
		exit2dView();
	}

	onDestroy(() => {
		disarm();
		layersOpen.set(false);
	});

	// the debug probe the suites read (ids in order; no state of its own)
	$effect(() => {
		if (typeof window === 'undefined') return;
		/** @type {any} */ (window).__toolbar2dDebug = () => ({ tools: tools.map((t) => t.id), last });
	});
</script>

<ToolboxWindow id="toolbar-2d" key="toolbar2d" title="2D" width={64} minW={56} defaultRect={{ left: 12, top: 140 }}>
	<div class="flex flex-col items-center gap-1" role="toolbar" aria-label="2D tools" aria-orientation="vertical">
		{#each tools as tool (tool.id)}
			{@const on = !!actives[tool.id] || (!tool.active && tool.id === 'select' && last === 'select')}
			<button
				type="button"
				id="tool2d-{tool.id}"
				class="tbx-btn {on ? 'tbx-on bg-accent-fill text-on-accent' : ''}"
				title={tool.title ?? tool.label}
				aria-label={tool.label}
				aria-pressed={tool.active || tool.id === 'select' ? on : undefined}
				onclick={() => press(tool)}><Icon name={tool.icon} size={20} aria-hidden="true" /></button
			>
		{/each}
		<button type="button" id="tool2d-back3d" class="tbx-cmd mt-1 w-full text-[length:var(--fs-badge)]" title="Back to 3D — the perspective view (only your view changes)" onclick={back}
			>Back to 3D</button
		>
	</div>
</ToolboxWindow>

{#if $layersOpen}<Layers2dPanel />{/if}
