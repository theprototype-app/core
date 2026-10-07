<script>
	// 34 PF — THE RECORDINGS LIST: live sources (a headset streaming to this desktop) on top,
	// then the saved recordings, pinned first, newest first. A row says what it was — light or
	// detailed, a moment, a beacon sample — and its headline numbers; its buttons pin, rename,
	// export (.tpprof) and delete (a second press confirms). In compare mode each row also
	// takes the A or B slot.
	import Icon from '../../ui/Icon.svelte';
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
					onclick={() => onexport(key)}><Icon name="download" size={16} aria-hidden="true" /></button
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
						>{#if row.pinned}<Icon name="pin"
								size={16}
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
					{#if row.pinned}<Icon name="pin-off" size={16} aria-hidden="true" />{:else}<Icon name="pin"
							size={16}
							aria-hidden="true"
						/>{/if}
				</button>
				<button class="pf-icon" aria-label="Rename {row.name}" onclick={() => startRename(row)}
					><Icon name="pencil" size={16} aria-hidden="true" /></button
				>
				<button
					class="pf-icon"
					aria-label="Export {row.name} as .tpprof"
					onclick={() => onexport(key)}><Icon name="download" size={16} aria-hidden="true" /></button
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
						>{:else}<Icon name="trash-2" size={16} aria-hidden="true" />{/if}
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
		background: color-mix(in srgb, var(--tp-hover) 70%, transparent);
	}
	.pf-sel {
		background: color-mix(in srgb, var(--tp-accent) 18%, transparent);
		box-shadow: inset 2px 0 0 var(--tp-accent);
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
		outline: 1px solid var(--tp-accent);
	}
	.pf-rec-name {
		font-size: 12px;
		color: var(--tp-ink);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		display: flex;
		align-items: center;
		gap: 3px;
	}
	.pf-rec-meta {
		font-size: 10.5px;
		color: var(--tp-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	/* on the selected row's accent tint the muted ink drops under 4.5:1 (light, green) */
	.pf-sel .pf-rec-meta {
		color: var(--tp-ink-2);
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
		color: var(--tp-muted);
	}
	.pf-icon:hover,
	.pf-ab:hover {
		color: var(--tp-ink);
		background: var(--tp-hover);
	}
	.pf-icon:disabled {
		opacity: 0.4;
	}
	.pf-danger {
		color: #fff;
		background: #b91c1c;
	}
	.pf-ab {
		font-size: 10px;
		font-weight: 700;
		border: 1px solid var(--tp-line);
	}
	.pf-ab[aria-pressed='true'] {
		background: var(--accent-fill, #2563eb);
		color: var(--on-accent, #fff);
	}
	.pf-badge {
		display: inline-block;
		padding: 0 4px;
		border-radius: 3px;
		font-size: 9.5px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		background: color-mix(in srgb, var(--tp-muted) 30%, transparent);
		color: var(--tp-ink);
	}
	.pf-badge-detailed {
		background: color-mix(in srgb, #a855f7 38%, transparent);
	}
	.pf-live {
		display: inline-block;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--tp-muted);
	}
	.pf-live-on {
		background: var(--ink-bad);
		animation: pf-blink 1.2s ease-in-out infinite;
	}
	@keyframes pf-blink {
		50% {
			opacity: 0.35;
		}
	}
	.pf-empty-list {
		font-size: 11.5px;
		color: var(--tp-muted);
		padding: 6px 4px;
	}
	:global(.pf-pin-mark) {
		flex: 0 0 auto;
		color: var(--tp-accent);
	}
</style>
