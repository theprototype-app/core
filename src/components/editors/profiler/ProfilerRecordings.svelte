<script>
	// 34 PF — THE RECORDINGS LIST: live sources (a headset streaming to this desktop) on top,
	// then the saved recordings, pinned first, newest first. A row says what it was — light or
	// detailed, a moment, a beacon sample — and its headline numbers; its buttons pin, rename,
	// export (.tpprof) and delete (a second press confirms). In compare mode each row also
	// takes the A or B slot.
	import { Pin, PinOff, Pencil, Download, Trash2 } from '@lucide/svelte';
	import { fmtSec } from '$lib/perf/profilerModel.js';

	/**
	 * @type {{
	 *   rows: any[], live: import('$lib/perf/profilerView.js').LiveSource[],
	 *   selected: string | null, compareOn: boolean, compareA: string | null, compareB: string | null,
	 *   onselect: (key: string) => void, onrename: (id: string, name: string) => void,
	 *   ondelete: (id: string) => void, onpin: (id: string, on: boolean) => void,
	 *   onexport: (key: string) => void, oncompare: (slot: 'a' | 'b', key: string) => void
	 * }}
	 */
	let {
		rows,
		live,
		selected,
		compareOn,
		compareA,
		compareB,
		onselect,
		onrename,
		ondelete,
		onpin,
		onexport,
		oncompare
	} = $props();

	const ordered = $derived(
		[...rows].sort(
			(x, y) => Number(!!y.pinned) - Number(!!x.pinned) || (y.startedAt ?? 0) - (x.startedAt ?? 0)
		)
	);

	let renaming = $state(/** @type {string | null} */ (null));
	let draft = $state('');
	let confirmDelete = $state(/** @type {string | null} */ (null));
	/** @type {any} */
	let confirmTimer = null;

	/** @param {any} row */
	function startRename(row) {
		renaming = row.id;
		draft = row.name;
	}
	function commitRename() {
		if (renaming && draft.trim()) onrename(renaming, draft.trim());
		renaming = null;
	}
	/** @param {HTMLInputElement} node */
	function focusSelect(node) {
		node.focus();
		node.select();
	}
	/** @param {string} id */
	function askDelete(id) {
		if (confirmDelete === id) {
			clearTimeout(confirmTimer);
			confirmDelete = null;
			ondelete(id);
			return;
		}
		confirmDelete = id;
		clearTimeout(confirmTimer);
		confirmTimer = setTimeout(() => (confirmDelete = null), 3000);
	}

	/** @param {any} row */
	function kindLabel(row) {
		if (row.kind === 'moment') return 'moment';
		if (row.kind === 'sample' || row.kind === 'stall') return 'beacon ' + row.kind;
		return row.mode;
	}
	/** @param {number} at */
	function when(at) {
		const d = new Date(at);
		const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
		return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}
</script>

<ul id="profiler-recordings" class="pf-list" aria-label="Recordings">
	{#each live as src (src.id)}
		{@const key = 'live:' + src.id}
		<li class="pf-rec" class:pf-sel={selected === key} data-key={key}>
			<button class="pf-rec-main" aria-current={selected === key} onclick={() => onselect(key)}>
				<span class="pf-rec-name"
					><span class="pf-live" class:pf-live-on={src.live} aria-hidden="true"
					></span>{src.label}</span
				>
				<span class="pf-rec-meta"
					>{src.live ? 'live' : 'stream ended'} · {src.doc
						? `${src.doc.frames.length} frames`
						: 'waiting for frames'}</span
				>
			</button>
			<div class="pf-rec-acts">
				{#if compareOn}
					<button
						class="pf-ab"
						aria-pressed={compareA === key}
						aria-label="Use {src.label} as A"
						onclick={() => oncompare('a', key)}>A</button
					>
					<button
						class="pf-ab"
						aria-pressed={compareB === key}
						aria-label="Use {src.label} as B"
						onclick={() => oncompare('b', key)}>B</button
					>
				{/if}
				<button
					class="pf-icon"
					aria-label="Save a copy of {src.label} as a recording"
					title="Save a copy"
					disabled={!src.doc}
					onclick={() => onexport(key)}><Download size={13} aria-hidden="true" /></button
				>
			</div>
		</li>
	{/each}
	{#each ordered as row (row.id)}
		{@const key = 'rec:' + row.id}
		<li
			class="pf-rec"
			class:pf-sel={selected === key}
			data-key={key}
			data-id={row.id}
			data-mode={row.mode}
		>
			{#if renaming === row.id}
				<input
					class="ui-input pf-rename w-full"
					aria-label="Recording name"
					bind:value={draft}
					use:focusSelect
					onkeydown={(/** @type {KeyboardEvent} */ e) => {
						if (e.key === 'Enter') commitRename();
						else if (e.key === 'Escape') renaming = null;
						e.stopPropagation();
					}}
					onblur={commitRename}
				/>
			{:else}
				<button
					class="pf-rec-main"
					aria-current={selected === key}
					ondblclick={() => startRename(row)}
					onclick={() => onselect(key)}
				>
					<span class="pf-rec-name"
						>{#if row.pinned}<Pin
								size={11}
								aria-label="pinned"
								class="pf-pin-mark"
							/>{/if}{row.name}</span
					>
					<span class="pf-rec-meta">
						<span class="pf-badge pf-badge-{row.mode}">{kindLabel(row)}</span>
						{fmtSec(row.durationMs || row.summary?.durationMs || 0)}
						{#if row.summary?.fpsP50}· {Math.round(row.summary.fpsP50)} fps{/if}
						{#if row.summary?.callsP50 !== null && row.summary?.callsP50 !== undefined}· {row
								.summary.callsP50} calls{/if}
						{#if row.summary?.stalls}· <span class="text-red-400"
								>{row.summary.stalls} stall{row.summary.stalls === 1 ? '' : 's'}</span
							>{/if}
						· {when(row.startedAt)}{#if row.xr}
							· VR{/if}{#if row.scene}
							· {row.scene}{/if}
					</span>
				</button>
			{/if}
			<div class="pf-rec-acts">
				{#if compareOn}
					<button
						class="pf-ab"
						aria-pressed={compareA === key}
						aria-label="Use {row.name} as A"
						onclick={() => oncompare('a', key)}>A</button
					>
					<button
						class="pf-ab"
						aria-pressed={compareB === key}
						aria-label="Use {row.name} as B"
						onclick={() => oncompare('b', key)}>B</button
					>
				{/if}
				<button
					class="pf-icon"
					aria-label={row.pinned
						? `Unpin ${row.name}`
						: `Pin ${row.name} (kept when old recordings are cleared)`}
					aria-pressed={!!row.pinned}
					onclick={() => onpin(row.id, !row.pinned)}
				>
					{#if row.pinned}<PinOff size={13} aria-hidden="true" />{:else}<Pin
							size={13}
							aria-hidden="true"
						/>{/if}
				</button>
				<button class="pf-icon" aria-label="Rename {row.name}" onclick={() => startRename(row)}
					><Pencil size={13} aria-hidden="true" /></button
				>
				<button
					class="pf-icon"
					aria-label="Export {row.name} as .tpprof"
					onclick={() => onexport(key)}><Download size={13} aria-hidden="true" /></button
				>
				<button
					class="pf-icon"
					class:pf-danger={confirmDelete === row.id}
					aria-label={confirmDelete === row.id
						? `Press again to delete ${row.name}`
						: `Delete ${row.name}`}
					onclick={() => askDelete(row.id)}
				>
					{#if confirmDelete === row.id}<span class="text-[10px] font-semibold">Delete?</span
						>{:else}<Trash2 size={13} aria-hidden="true" />{/if}
				</button>
			</div>
		</li>
	{:else}
		{#if !live.length}
			<li class="pf-empty-list">
				No recordings yet. Record one, or take the last 30 seconds the app always keeps.
			</li>
		{/if}
	{/each}
</ul>

<style>
	.pf-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.pf-rec {
		position: relative;
		border-radius: 3px;
		padding: 2px 2px 2px 4px;
	}
	.pf-rec:hover {
		background: rgb(75 85 99 / 0.3);
	}
	.pf-sel {
		background: rgb(59 130 246 / 0.22);
		box-shadow: inset 2px 0 0 var(--accent, #3b82f6);
	}
	.pf-rec-main {
		display: flex;
		flex-direction: column;
		width: 100%;
		text-align: left;
		padding-right: 2px;
		border-radius: 2px;
	}
	.pf-rec-main:focus-visible,
	.pf-icon:focus-visible,
	.pf-ab:focus-visible {
		outline: 1px solid var(--accent, #3b82f6);
	}
	.pf-rec-name {
		font-size: 12px;
		color: #e5e7eb;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 3px;
	}
	.pf-rec-meta {
		font-size: 10.5px;
		color: #9ca3af;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.pf-rec-acts {
		display: flex;
		gap: 2px;
		justify-content: flex-end;
		opacity: 0.55;
	}
	.pf-rec:hover .pf-rec-acts,
	.pf-rec:focus-within .pf-rec-acts,
	.pf-sel .pf-rec-acts {
		opacity: 1;
	}
	.pf-icon,
	.pf-ab {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 20px;
		height: 18px;
		padding: 0 3px;
		border-radius: 3px;
		color: #9ca3af;
	}
	.pf-icon:hover,
	.pf-ab:hover {
		color: #e5e7eb;
		background: rgb(75 85 99 / 0.5);
	}
	.pf-icon:disabled {
		opacity: 0.4;
	}
	.pf-danger {
		color: #fff;
		background: #dc2626;
	}
	.pf-ab {
		font-size: 10px;
		font-weight: 700;
		border: 1px solid var(--border, #374151);
	}
	.pf-ab[aria-pressed='true'] {
		background: var(--accent, #3b82f6);
		color: #fff;
	}
	.pf-badge {
		display: inline-block;
		padding: 0 4px;
		border-radius: 3px;
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		background: rgb(75 85 99 / 0.6);
		color: #e5e7eb;
	}
	.pf-badge-detailed {
		background: rgb(126 34 206 / 0.6);
	}
	.pf-live {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: #6b7280;
	}
	.pf-live-on {
		background: #ef4444;
		animation: pf-blink 1.2s ease-in-out infinite;
	}
	@keyframes pf-blink {
		50% {
			opacity: 0.35;
		}
	}
	.pf-empty-list {
		font-size: 11.5px;
		color: #9ca3af;
		padding: 6px 4px;
	}
	:global(.pf-pin-mark) {
		flex: 0 0 auto;
		color: var(--accent, #3b82f6);
	}
</style>
