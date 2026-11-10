<script>
	// 48 D1 — THE DEBUGGER PANEL. Breakpoints, Pause / Step / Resume, the focused node's wires with
	// their live values, and the watch list. On the shared ToolboxWindow shell (a floating palette
	// on desktop, a bottom sheet at <=640px) and mounted OUTSIDE App.svelte's Play gate, because Play
	// is where it works: the node editor is unmounted there. Everything here is LOCAL — the runtime
	// half is flowRuntime's paused view, reached through $lib/flowDebug.js.
	import Icon from '../ui/Icon.svelte';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import {
		debugStatus,
		debugValues,
		debugBreakpoints,
		debugWatches,
		debugFocus,
		requestDebug,
		toggleBreakpoint,
		clearBreakpoints,
		addWatch,
		removeWatch,
		setDebugOpen
	} from '$lib/flowDebug.js';
	import { watchKey } from '$lib/flowDebugCore.js';
	import { flowGraphs, SCENE_GRAPH } from '../../stores/flowStore';
	import { isLocked, isVRMode, objectsGroup } from '../../stores/sceneStore';
	import { findNodeSpec } from '$lib/nodeCatalog';
	// 78 F14: the Console — what Announce nodes and modules said, with the time and the source
	import { announceLog, announceUnread, clearAnnounceLog } from '$lib/gameAnnounce';
	import { minimalScroll } from '$lib/ui/minimalScroll.js';

	const playing = $derived($isLocked === true);
	const paused = $derived($debugStatus.mode === 'paused');
	const live = $derived(playing && !$isVRMode);

	/** node id -> {node, graph id}, for labels (breakpoints and watches outlive their values) */
	const index = $derived.by(() => {
		/** @type {Map<string, {node: any, graph: string}>} */
		const map = new Map();
		for (const [graph, doc] of Object.entries($flowGraphs ?? {}))
			for (const node of /** @type {any} */ (doc)?.nodes ?? []) map.set(node.id, { node, graph });
		return map;
	});
	/** @param {string} id */
	function labelOf(id) {
		const hit = index.get(id);
		if (!hit) return null;
		const own = typeof hit.node.data?.label === 'string' ? hit.node.data.label.trim() : '';
		return own || findNodeSpec(hit.node.type)?.label || hit.node.type;
	}
	/** which flow a node sits in: the scene's, or an object's (its name) @param {string} id */
	function graphOf(id) {
		const hit = index.get(id);
		if (!hit || hit.graph === SCENE_GRAPH) return 'Scene';
		return $objectsGroup?.getObjectByProperty?.('uuid', hit.graph)?.name || 'Object flow';
	}

	const whyText = /** @type {Record<string, string>} */ ({
		breakpoint: 'an event is about to reach it',
		step: 'stepped — this event ran',
		moment: 'a scheduled moment ran',
		pause: 'paused by you'
	});

	/** newest first, for the Console @type {any[]} */
	const consoleRows = $derived([...$announceLog].reverse());
	// the panel is open: whatever arrives is seen
	$effect(() => {
		void $announceLog;
		announceUnread.set(0);
	});
	/** HH:MM:SS of a moment @param {number} t */
	const clock = (t) => new Date(t).toTimeString().slice(0, 8);

	let watchKind = $state('var');
	let watchName = $state('');
	function addNamedWatch() {
		const key = watchName.trim();
		if (!key) return;
		addWatch({ kind: watchKind === 'player' ? 'player' : 'var', key });
		watchName = '';
	}

	// what the watch rows say: the runtime's values while it runs, the names alone otherwise
	const watchRows = $derived(
		live && $debugValues.watches.length === $debugWatches.length
			? $debugValues.watches
			: $debugWatches.map((w) => ({
					key: watchKey(w),
					label: w.kind === 'node' ? (labelOf(w.key) ?? 'missing node') + (w.handle ? '.' + w.handle : '') : w.key + (w.kind === 'player' ? ' (mine)' : ''),
					text: '—',
					missing: w.kind === 'node' && !index.has(w.key)
				}))
	);

	// F8 pause / resume, F10 step — the debugger keys of every IDE. Only while playing: the pointer
	// is locked then, so a key is the only way to pause without a breakpoint.
	$effect(() => {
		if (!live) return;
		/** @param {KeyboardEvent} event */
		const onKey = (event) => {
			if (event.key !== 'F8' && event.key !== 'F10') return;
			event.preventDefault();
			event.stopPropagation();
			if (event.key === 'F10') requestDebug('step');
			else requestDebug(paused ? 'resume' : 'pause');
		};
		window.addEventListener('keydown', onKey, true);
		return () => window.removeEventListener('keydown', onKey, true);
	});
</script>

<ToolboxWindow
	id="flow-debugger"
	key="flowDebugger"
	title="Debugger"
	icon="bug"
	width={300}
	minW={240}
	defaultRect={{ right: 16, top: 76 }}
	onclose={() => setDebugOpen(false)}
>
	{#snippet actions()}
		{#if live}
			{#if paused}
				<button id="debug-step" class="tbx-hbtn" aria-label="Step" title="Step — run the next event (F10)" onclick={() => requestDebug('step')}
					><Icon name="step-forward" size={16} aria-hidden="true" /></button
				>
				<button id="debug-resume" class="tbx-hbtn tbx-ok" aria-label="Resume" title="Resume — rejoin the live game (F8)" onclick={() => requestDebug('resume')}
					><Icon name="play" size={16} aria-hidden="true" /></button
				>
			{:else}
				<button id="debug-pause" class="tbx-hbtn" aria-label="Pause" title="Pause your view of the game now (F8)" onclick={() => requestDebug('pause')}
					><Icon name="pause" size={16} aria-hidden="true" /></button
				>
			{/if}
		{/if}
		<button id="debug-close" class="tbx-hbtn" data-tbx-close aria-label="Close" title="Close the debugger" onclick={() => setDebugOpen(false)}
			><Icon name="x" size={16} aria-hidden="true" /></button
		>
	{/snippet}

	<div class="tbx-row text-xs" id="debug-status" data-mode={live ? $debugStatus.mode : 'off'}>
		{#if !playing}
			<span class="text-text-muted">Set breakpoints here or in the node editor (F9), then press Play. Play pauses when an event reaches one.</span>
		{:else if $isVRMode}
			<span class="text-text-muted">Breakpoints are off in VR.</span>
		{:else if paused}
			<span class="flex w-full flex-col gap-0.5">
				<span>
					<Icon name="pause" size={16} aria-hidden="true" />
					Paused at <b id="debug-at">{$debugStatus.at?.label ?? '—'}</b>
					<span class="text-text-muted">· {whyText[$debugStatus.at?.why ?? 'pause']}</span>
				</span>
				<span id="debug-queue" class="text-text-muted">
					{#if $debugStatus.queued}
						{$debugStatus.queued} event{$debugStatus.queued === 1 ? '' : 's'} waiting · next: {$debugStatus.next}
					{:else if $debugStatus.waiting}
						Waiting for the next event…
					{:else}
						Nothing waiting — Step runs the next event when it comes
					{/if}
					{#if $debugStatus.dropped}· {$debugStatus.dropped} older dropped{/if}
				</span>
				{#if $debugStatus.sandboxed}
					<span id="debug-sandboxed" class="text-text-muted">Other players keep playing; shared values you step stay in this view.</span>
				{/if}
			</span>
		{:else}
			<span>
				<span class="text-text-muted">Running</span> · {$debugBreakpoints.length} breakpoint{$debugBreakpoints.length === 1 ? '' : 's'}
				<span class="text-text-muted">· F8 pauses</span>
			</span>
		{/if}
	</div>

	<p class="tbx-label">Console</p>
	<div class="tbx-row debug-console" id="debug-console" use:minimalScroll>
		{#each consoleRows as row (row.id)}
			<div class="debug-wire debug-line" data-announce={row.id} data-shown={row.shown}>
				<span class="debug-handle">{clock(row.at)}</span>
				<span class="debug-text" title={row.sub ? row.text + ' / ' + row.sub : row.text}>{row.text}{#if row.sub}<span class="text-text-muted"> · {row.sub}</span>{/if}</span>
				{#if row.source?.kind === 'node'}
					<button class="debug-node debug-src" title="Show this node's wires" onclick={() => debugFocus.set(row.source.nodeId)}>{row.source.label || labelOf(row.source.nodeId) || 'Announce'}</button>
				{:else if row.source}
					<span class="debug-handle">{row.source.label}</span>
				{/if}
			</div>
		{:else}
			<span class="text-[11px] text-text-muted">What Announce nodes say in Edit shows here; in Play it is a banner.</span>
		{/each}
	</div>
	{#if consoleRows.length}
		<div class="tbx-row"><button id="debug-console-clear" class="tbx-cmd" onclick={() => clearAnnounceLog()}>Clear console</button></div>
	{/if}

	{#if $debugValues.focus && live}
		{@const focus = $debugValues.focus}
		<p class="tbx-label">Wires · {focus.label}</p>
		{#if focus.why}
			<div class="tbx-row text-[11px]" id="debug-why">
				<span class="text-text-muted">{focus.why.last}</span>
				{#if focus.why.standing}<span class="debug-why-block text-warn-text">{focus.why.standing}</span>{/if}
			</div>
		{/if}
		{#if focus.eventless}
			<p class="tbx-row text-[11px] text-text-muted">No event reaches this node, so a breakpoint here never pauses — watch it instead.</p>
		{/if}
		<div class="tbx-row" id="debug-wires-in">
			{#each $debugValues.inputs as row (row.edgeId)}
				<div class="debug-wire" data-edge={row.edgeId} data-kind={row.kind}>
					<button class="debug-node" title="Show this node's wires" onclick={() => debugFocus.set(row.nodeId)}>← {row.label}</button>
					<span class="debug-handle">{row.handle}</span>
					<span class="debug-value" class:debug-high={row.high}>{row.text}</span>
				</div>
			{:else}
				<span class="text-[11px] text-text-muted">nothing wired in</span>
			{/each}
		</div>
		<div class="tbx-row" id="debug-wires-out">
			{#each $debugValues.outputs as row (row.edgeId)}
				<div class="debug-wire" data-edge={row.edgeId} data-kind={row.kind}>
					<button class="debug-node" title="Show this node's wires" onclick={() => debugFocus.set(row.nodeId)}>→ {row.label}</button>
					<span class="debug-handle">{row.handle}</span>
					<span class="debug-value" class:debug-high={row.high}>{row.text}</span>
				</div>
			{:else}
				<span class="text-[11px] text-text-muted">nothing wired out</span>
			{/each}
		</div>
		<div class="tbx-row">
			<button id="debug-watch-focus" class="tbx-cmd" onclick={() => addWatch({ kind: 'node', key: focus.id })}>Watch {focus.label}</button>
			{#if $debugFocus}
				<button class="tbx-cmd" onclick={() => debugFocus.set(null)}>Back to the paused node</button>
			{/if}
		</div>
	{/if}

	<p class="tbx-label">Watch</p>
	<div class="tbx-row" id="debug-watch-list">
		{#each watchRows as row (row.key)}
			<div class="debug-wire" data-watch={row.key}>
				<span class="debug-node debug-static" class:text-text-muted={row.missing}>{row.label}</span>
				<span class="debug-value">{row.text}</span>
				<button class="debug-x" aria-label="Stop watching" title="Stop watching" onclick={() => removeWatch(row.key)}><Icon name="x" size={16} aria-hidden="true" /></button>
			</div>
		{:else}
			<span class="text-[11px] text-text-muted">Add a variable, or a node from its wires.</span>
		{/each}
	</div>
	<form
		class="tbx-row"
		onsubmit={(e) => {
			e.preventDefault();
			addNamedWatch();
		}}
	>
		<select id="debug-watch-kind" class="ui-input w-24 text-[11px]" bind:value={watchKind} aria-label="What to watch">
			<option value="var">Variable</option>
			<option value="player">My variable</option>
		</select>
		<input id="debug-watch-name" class="ui-input min-w-0 flex-1 text-[11px]" placeholder="score" maxlength="40" bind:value={watchName} aria-label="Variable name" />
		<button id="debug-watch-add" class="tbx-cmd" type="submit" disabled={!watchName.trim()}>Add</button>
	</form>

	<p class="tbx-label">Breakpoints</p>
	<div class="tbx-row" id="debug-bp-list">
		{#each $debugBreakpoints as id (id)}
			<div class="debug-wire" data-bp={id} class:debug-at={$debugStatus.at?.bp === id && paused}>
				<button class="debug-node" title="Show this node's wires" onclick={() => debugFocus.set(id)}
					><span class="debug-dot" aria-hidden="true"></span>{labelOf(id) ?? 'not in this scene'}</button
				>
				<span class="debug-handle">{index.has(id) ? graphOf(id) : ''}</span>
				<button class="debug-x" aria-label="Remove breakpoint" title="Remove breakpoint" onclick={() => toggleBreakpoint(id, false)}><Icon name="x" size={16} aria-hidden="true" /></button>
			</div>
		{:else}
			<span class="text-[11px] text-text-muted">Right-click a node ▸ Breakpoint, or select it and press F9.</span>
		{/each}
	</div>
	{#if $debugBreakpoints.length}
		<div class="tbx-row"><button id="debug-bp-clear" class="tbx-cmd" onclick={() => clearBreakpoints()}>Clear all</button></div>
	{/if}

	{#snippet status()}
		<span>Only you see this · other players keep playing</span>
	{/snippet}
</ToolboxWindow>

<style>
	#debug-why {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.debug-wire {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		min-width: 0;
		padding: 1px 2px;
		border-radius: 4px;
		font-size: 11px;
	}
	.debug-wire:hover {
		background: var(--surface-hover);
	}
	.debug-wire.debug-at {
		box-shadow: inset 2px 0 0 var(--danger);
	}
	.debug-node {
		display: flex;
		align-items: center;
		gap: 4px;
		min-width: 0;
		flex: 1 1 auto;
		overflow: hidden;
		text-align: left;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--text);
	}
	.debug-node.debug-static {
		cursor: default;
	}
	.debug-handle {
		flex: 0 0 auto;
		color: var(--text-muted);
		font-family: var(--font-mono, monospace);
	}
	.debug-value {
		flex: 0 0 auto;
		max-width: 45%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono, monospace);
		color: var(--text-2);
	}
	.debug-value.debug-high {
		color: var(--accent);
		font-weight: 600;
	}
	.tbx-row.debug-console {
		max-height: 140px;
		overflow-y: auto;
		flex-direction: column;
		align-items: stretch;
	}
	.debug-text {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		color: var(--text);
	}
	.debug-node.debug-src {
		flex: 0 1 auto;
		max-width: 40%;
		color: var(--accent);
	}
	.debug-x {
		flex: 0 0 auto;
		color: var(--text-muted);
	}
	.debug-x:hover {
		color: var(--text);
	}
	.debug-dot {
		flex: 0 0 auto;
		width: 8px;
		height: 8px;
		border-radius: 9999px;
		background: var(--danger);
	}
</style>
