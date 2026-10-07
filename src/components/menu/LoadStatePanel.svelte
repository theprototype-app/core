<script>
	// 36 U9 — the Inspector's "Loading" section for a kit piece that is still on its way:
	// where its file is, how far it got, why it stopped, and the three ways out (Retry,
	// Replace model…, Remove). Runes mode, its own file (the Inspector is legacy).
	import Icon from '../ui/Icon.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { loadRevision, describeLoad, progressOf, visualState, placeholderStuckSeconds, formatBytes, RETRY_DELAYS, loadNow, VIS_STUCK, VIS_FAILED } from '$lib/loadStates';
	import { stubLoadInfo, retryPlaceholder } from '$lib/packRefs';
	import { openReplaceModel } from '$lib/replaceModel';
	import { deleteObjectsByUuid } from '$lib/objectActions';

	/** @type {{object: any}} */
	let { object } = $props();

	// progress moves without a store write (bytes never bump the revision), so re-read twice
	// a second while the panel is open
	let tick = $state(0);
	$effect(() => {
		const timer = setInterval(() => tick++, 500);
		return () => clearInterval(timer);
	});

	/**
	 * One snapshot per tick/store change. The FileLoad record is mutated in place as bytes
	 * arrive, so a derived over it would compare equal and never re-run — every value is
	 * computed here, with the stores passed as ARGUMENTS so the derived depends on them.
	 * @param {any} o @param {number} _t @param {number} _rev @param {any} _group @param {number} stuckSeconds
	 */
	function viewOf(o, _t, _rev, _group, stuckSeconds) {
		const info = stubLoadInfo(o);
		if (!info) return null;
		const load = info.load;
		const now = loadNow();
		const state = visualState(load, now, stuckSeconds * 1000);
		const progress = progressOf(load);
		let label = 'Waiting for its file…';
		if (load?.phase === 'failed') label = 'Failed — ' + (load.error?.reason ?? 'unknown error') + (load.error?.status ? ' (HTTP ' + load.error.status + ')' : '');
		else if (load?.phase === 'waiting')
			label = 'Retrying in ' + Math.max(0, Math.ceil((load.retryAt - now) / 1000)) + ' s — ' + (load.error?.reason ?? '') + ' (attempt ' + (load.attempt + 2) + ' of ' + (RETRY_DELAYS.length + 1) + ')';
		else if (load?.phase === 'parsing') label = 'Preparing the model…';
		else if (load && state === VIS_STUCK) label = 'Stuck — no data for ' + Math.round((now - load.lastByteAt) / 1000) + ' s';
		else if (load) label = 'Loading ' + (progress >= 0 ? Math.round(progress * 100) + '% · ' : '') + formatBytes(load.loaded) + (load.total ? ' of ' + formatBytes(load.total) : '');
		const tone = state === VIS_FAILED ? 'var(--icon-danger)' : state === VIS_STUCK ? 'var(--icon-warning, var(--icon-danger))' : 'var(--accent)';
		return { ...info, state, progress, label, tone, tip: describeLoad(load) };
	}
	const view = $derived(viewOf(object, tick, $loadRevision, $objectsGroup, $placeholderStuckSeconds));
</script>

{#if view}
	<div id="load-state-panel" class="flex flex-col gap-1.5 px-1 text-xs" data-state={view.load?.phase ?? 'waiting'}>
		<div class="flex items-center gap-1.5">
			<span class="load-dot" style:background={view.tone}></span>
			<span id="load-state-label" class="min-w-0 flex-1" title={view.tip}>{view.label}</span>
		</div>
		{#if view.load && view.load.phase !== 'failed'}
			<div class="load-track" aria-hidden="true">
				<div class="load-fill" class:indeterminate={view.progress < 0} style:width={(view.progress < 0 ? 35 : Math.round(view.progress * 100)) + '%'} style:background={view.tone}></div>
			</div>
		{/if}
		<div class="truncate opacity-80" title={view.url}>
			{view.item}{view.pack ? ' · ' + view.pack : ''}
		</div>
		<div id="load-state-url" class="load-url truncate" title={view.url}>{view.url}</div>
		<div class="mt-1 flex flex-wrap gap-1">
			<button
				id="load-retry"
				class="ui-chip inline-flex items-center gap-1 bg-gray-600 text-gray-200 hover:bg-gray-500"
				title="Fetch the file again now (every copy of this piece comes back with it)"
				onclick={() => retryPlaceholder(object)}
			>
				<Icon name="refresh-cw" size={16} />Retry
			</button>
			<button
				id="load-replace"
				class="ui-chip inline-flex items-center gap-1 bg-gray-600 text-gray-200 hover:bg-gray-500"
				title="Put a different pack item or library model here, keeping the position, rotation and scale"
				onclick={() => openReplaceModel(object.uuid)}
			>
				<Icon name="folder-input" size={16} />Replace model…
			</button>
			<button
				id="load-remove"
				class="ui-chip inline-flex items-center gap-1 bg-gray-600 text-gray-200 hover:bg-gray-500"
				title="Delete this piece (undoable)"
				onclick={() => deleteObjectsByUuid([object.uuid])}
			>
				<Icon name="trash-2" size={16} />Remove
			</button>
		</div>
		<p class="text-[10px] italic opacity-70">You can move, rotate and scale it now — the model arrives where the box is.</p>
	</div>
{/if}

<style>
	.load-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		flex: none;
	}
	.load-track {
		height: 4px;
		border-radius: 2px;
		background: var(--field, rgba(127, 127, 127, 0.25));
		overflow: hidden;
	}
	.load-fill {
		height: 100%;
		border-radius: 2px;
		transition: width 0.4s ease;
	}
	.load-fill.indeterminate {
		animation: load-slide 1.4s ease-in-out infinite;
	}
	@keyframes load-slide {
		0% {
			transform: translateX(-100%);
		}
		100% {
			transform: translateX(300%);
		}
	}
	.load-url {
		font-family: ui-monospace, monospace;
		font-size: 10px;
		color: var(--muted, inherit);
	}
	@media (prefers-reduced-motion: reduce) {
		.load-fill.indeterminate {
			animation: none;
		}
	}
</style>
