<script>
	// R22 round 13 P2 — THE STORAGE BREAKDOWN. "What consumed how much space, as a list,
	// and let me clean up per item or the whole store."
	//
	// A NON-MODAL native dialog (`modal={false}` -> dialog.show()), the app's rule for
	// every panel-shaped modal: the chrome above it deliberately stays alive, and a
	// showModal() dialog would make the logo, the Connect bar, the approval toasts and
	// every body-portaled menu INERT. Only ConfirmModal and the duplicate-import prompt
	// keep true modality, because both are blocking decisions. This is a panel you read.
	//
	// The confirm for the act itself is ConfirmModal — so the one truly blocking moment in
	// this feature uses the one dialog built for blocking, and a reclaim can never happen
	// because somebody clicked past a tooltip.
	//
	// GROUPED, NOT FLAT. The user's own words were "saves sessions, scenes etc.", which is
	// a request for categories rather than a list of keys — and it is also the only way the
	// per-category select-all can exist. Every group carries ONE sentence saying what
	// deleting it costs, because that is the question somebody freeing space is actually
	// asking and it cannot be inferred from a byte count.
	import { untrack } from 'svelte';
	import { Modal, Button } from 'flowbite-svelte';
	import { HardDrive, RefreshCw, Trash2, Info, ChevronRight } from '@lucide/svelte';
	import { showConfirm } from '$lib/confirmDialog';
	import { showToast } from '../../stores/appStore';
	import {
		storageModalOpen,
		storageScan,
		storageScanning,
		scanStorage,
		reclaimRows,
		selectionBytes,
		fmtBytes
	} from '$lib/storageUsage';

	/** the row ids ticked for removal @type {Set<string>} */
	let picked = $state(new Set());
	/** the scan those ticks were RECONCILED against — see the effect below */
	let pickedAt = $state(0);
	let busy = $state(false);
	/** which category keys are EXPANDED. Collapsed is the default, and the set starts
	 * empty rather than being seeded from anything: a group's fold is a fact about this
	 * screen right now, so it is neither persisted nor replicated (the `explorerView`
	 * rule) — and a remembered expansion would quietly undo "collapsed by default".
	 * @type {Set<string>} */
	let expanded = $state(new Set());

	const scan = $derived($storageScan);
	/** categories with something in them — an empty group is noise, and its `note` has
	 * nothing to explain when there is nothing to explain it about */
	const groups = $derived((scan?.categories ?? []).filter((/** @type {any} */ c) => c.rows.length));
	const allRows = $derived(groups.flatMap((/** @type {any} */ c) => c.rows));
	const pickedRows = $derived(allRows.filter((/** @type {any} */ r) => picked.has(r.id)));
	const freeable = $derived(selectionBytes(pickedRows));

	// A NEW SCAN RECONCILES THE SELECTION — IT DOES NOT WIPE IT. The first version keyed
	// the invalidation on `scan.at`, a fresh `Date.now()` on EVERY scan, and emptied
	// `picked` whenever it moved. That is right for the rows a reclaim removed and wrong
	// for everything else, because `openStorageModal` ALWAYS starts a scan and the panel
	// is interactive on the previous reading while it runs: MEASURED, a tick made in that
	// window was silently dropped the moment the scan landed — the ticks disappeared and
	// Reclaim went back to disabled, over a row list that had not changed by a single
	// entry. On a big store that window is seconds long, which is the reported "Reclaim is
	// not enabled when items are selected".
	//
	// The original intent survives intact — a tick is a statement about a row that may no
	// longer exist — it is just enforced against the ROWS rather than against a clock: an
	// id the new scan still lists stays ticked, one it does not is dropped. `picked` is
	// read through `untrack` because this effect WRITES it; tracking it here would re-run
	// the effect on every tick for a comparison that can only ever be a no-op.
	$effect(() => {
		const at = scan?.at ?? 0;
		const live = new Set(allRows.map((/** @type {any} */ r) => r.id));
		if (at === pickedAt) return;
		pickedAt = at;
		untrack(() => {
			/** @type {Set<string>} */
			const kept = new Set();
			for (const id of picked) if (live.has(id)) kept.add(id);
			if (kept.size !== picked.size) picked = kept;
		});
	});

	/** @param {string} id */
	function toggle(id) {
		const row = allRows.find((/** @type {any} */ r) => r.id === id);
		if (!row?.removable) return;
		const next = new Set(picked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		picked = next;
	}

	/** @param {any} cat @returns {any[]} the rows in it that CAN be ticked */
	function pickableOf(cat) {
		return cat.rows.filter((/** @type {any} */ r) => r.removable);
	}

	/** @param {any} cat */
	function allPicked(cat) {
		const p = pickableOf(cat);
		return p.length > 0 && p.every((/** @type {any} */ r) => picked.has(r.id));
	}

	/** @param {any} cat */
	function toggleCategory(cat) {
		const p = pickableOf(cat);
		const next = new Set(picked);
		if (allPicked(cat)) for (const r of p) next.delete(r.id);
		else for (const r of p) next.add(r.id);
		picked = next;
	}

	/** how many rows of this group are ticked — the collapsed group's own readout, so a
	 * selection cannot hide behind a fold @param {any} cat */
	function pickedIn(cat) {
		return cat.rows.filter((/** @type {any} */ r) => picked.has(r.id)).length;
	}

	/** @param {string} key */
	function isOpen(key) {
		return expanded.has(key);
	}

	/** COLLAPSING IS A VIEW STATE, NEVER A SELECTION STATE. Nothing here touches `picked`,
	 * and `pickedRows` derives from the SCAN rather than from what is on screen — so a
	 * group ticked and then folded away stays ticked and still counts.
	 * @param {string} key */
	function toggleOpen(key) {
		const next = new Set(expanded);
		if (next.has(key)) next.delete(key);
		else next.add(key);
		expanded = next;
	}

	function toggleEverything() {
		const p = allRows.filter((/** @type {any} */ r) => r.removable);
		const every = p.length > 0 && p.every((/** @type {any} */ r) => picked.has(r.id));
		picked = every ? new Set() : new Set(p.map((/** @type {any} */ r) => r.id));
	}

	async function reclaim() {
		const rows = pickedRows.filter((/** @type {any} */ r) => r.removable);
		if (!rows.length || busy) return;
		const ok = await showConfirm({
			title: 'Reclaim ' + fmtBytes(freeable) + '?',
			message:
				rows.length +
				(rows.length === 1 ? ' item will be removed' : ' items will be removed') +
				' from this device, freeing about ' +
				fmtBytes(freeable) +
				'. This cannot be undone, and it only affects this machine — peers keep their own copies.',
			confirmLabel: 'Reclaim',
			cancelLabel: 'Keep them'
		});
		if (!ok) return;
		busy = true;
		try {
			const result = await reclaimRows(rows);
			showToast('Freed about ' + fmtBytes(result.freed));
		} finally {
			busy = false;
		}
	}

	/** the fill of the used/quota bar, as a percentage @param {any} s */
	function usedPct(s) {
		if (!s?.estimate?.quota) return 0;
		return Math.min(100, Math.max(0.5, (s.estimate.used / s.estimate.quota) * 100));
	}
</script>

<Modal
	title="Storage"
	bind:open={$storageModalOpen}
	modal={false}
	onkeydown={(/** @type {KeyboardEvent} */ e) => {
		if (e.key === 'Escape') storageModalOpen.set(false);
	}}
	outsideclose
	size="lg"
	class="tp-modal-frame"
	classes={{ header: 'tp-modal-header', body: 'tp-modal-body flex-1' }}
>
	<div id="storage-modal" class="modal-content p-3">
		<!--
			THE HONEST HEADER. `navigator.storage.estimate()` is a quota for the whole
			ORIGIN — localStorage, the caches, the service worker and IndexedDB's own
			overhead — so it is reported as its own line and the categories below are
			reported as OURS. Saying "the library is using 40 MB of your 2 GB" would be the
			claim the Explorer chip's comment already refuses to make.
		-->
		<div class="mb-3">
			<div class="mb-1 flex flex-wrap items-center gap-2">
				<span class="flex items-center gap-1.5 text-sm font-semibold text-gray-200">
					<HardDrive size={16} aria-hidden="true" />
					{#if scan?.estimate}
						{fmtBytes(scan.estimate.used)} used of {fmtBytes(scan.estimate.quota)} granted
					{:else}
						Browser storage
					{/if}
				</span>
				<Button
					id="storage-rescan"
					size="xs"
					color="alternative"
					disabled={$storageScanning || busy}
					onclick={() => void scanStorage()}
				>
					<RefreshCw size={14} class="mr-1" aria-hidden="true" />{$storageScanning ? 'Reading…' : 'Rescan'}
				</Button>
			</div>
			{#if scan?.estimate?.quota}
				<div class="storage-bar" aria-hidden="true">
					<div class="storage-bar-fill" style:width="{usedPct(scan)}%"></div>
				</div>
			{/if}
			{#if scan}
				<p id="storage-summary" class="mt-1.5 text-xs text-gray-400">
					This app accounts for <strong id="storage-accounted">{fmtBytes(scan.accounted)}</strong>
					of that across {scan.keys} stored records.
					{#if scan.unaccounted != null}
						<span id="storage-unaccounted-line">
							The remaining
							<strong id="storage-unaccounted">{fmtBytes(scan.unaccounted)}</strong>
							is everything else this origin keeps — cached code, browser bookkeeping and
							IndexedDB's own overhead — which no list here can clean up.
							{#if scan.unaccounted < 0}
								A negative figure means our own measurements add up to more than the browser
								reports; every number here is an estimate.
							{/if}
						</span>
					{/if}
				</p>
			{:else}
				<p class="mt-1.5 text-xs text-gray-400">Reading the store…</p>
			{/if}
		</div>

		{#if groups.length}
			<div class="mb-2 flex items-center justify-between">
				<p class="ui-section-label !mb-0">What is using it</p>
				<button id="storage-select-all" type="button" class="storage-link" onclick={toggleEverything}>
					Select everything removable
				</button>
			</div>

			<!--
				COLLAPSED BY DEFAULT, and the head reads as a head. Flat, every group's title
				sat in the same register as its own rows, so the list read as one long run of
				items with headings mixed into it. The head keeps its own surface, its own
				weight and a rule under it while open; the note and the rows live INSIDE the
				fold, so a shut group is exactly one line.

				NOT `ToolboxSection`: that one renders no wrapper element because its parent is
				a grid and every child has to stay a grid item — a reason that does not apply to
				this bordered card — and its whole head IS a <button>, which cannot contain the
				select-all checkbox this head has to carry. So the fold is hand-rolled: the
				chevron/label is the button, the tick sits beside it, and the tick keeps
				working while the group is shut.
			-->
			{#each groups as cat (cat.key)}
				{@const picks = pickedIn(cat)}
				<div class="storage-group" data-storage-group={cat.key} data-open={isOpen(cat.key)}>
					<div class="storage-group-head">
						<label class="storage-group-tick" title={pickableOf(cat).length ? 'Select all in this group' : 'Nothing in this group can be removed'}>
							<input
								class="tp-check"
								type="checkbox"
								id={'storage-group-check-' + cat.key}
								aria-label={'Select all ' + cat.label}
								disabled={!pickableOf(cat).length}
								checked={allPicked(cat)}
								onchange={() => toggleCategory(cat)} />
						</label>
						<button
							type="button"
							class="storage-group-toggle"
							id={'storage-group-toggle-' + cat.key}
							aria-expanded={isOpen(cat.key)}
							aria-controls={'storage-group-body-' + cat.key}
							onclick={() => toggleOpen(cat.key)}
						>
							<ChevronRight size={12} class="storage-group-chev" aria-hidden="true" />
							<span class="storage-group-name">{cat.label}</span>
							<span class="storage-group-count" data-picked={picks}
								>{cat.rows.length}{#if picks}<span class="storage-group-picked"
										>&nbsp;· {picks} selected</span
									>{/if}</span
							>
						</button>
						<span class="storage-group-bytes" data-bytes={cat.bytes}>{fmtBytes(cat.bytes)}</span>
					</div>
					{#if isOpen(cat.key)}
					<div id={'storage-group-body-' + cat.key} class="storage-group-body">
					<p class="storage-group-note">{cat.note}</p>
					<ul class="storage-rows">
						{#each cat.rows as row (row.id)}
							<li class="storage-row" data-storage-row={row.id} data-removable={row.removable}>
								<input
									class="tp-check"
									type="checkbox"
									aria-label={(row.removable ? 'Remove ' : 'Cannot remove ') + row.label}
									disabled={!row.removable || busy}
									title={row.removable ? undefined : row.reason}
									checked={picked.has(row.id)}
									onchange={() => toggle(row.id)} />
								<span class="storage-row-main">
									<span class="storage-row-name" title={row.label}>{row.label}</span>
									{#if row.sub}<span class="storage-row-sub">{row.sub}</span>{/if}
									<!--
										THE REASON, RENDERED. The app's convention is the Users popover's
										disabled Watch button with its reason beside it: a control that is
										absent teaches nothing, a control that is refused teaches the rule.
									-->
									{#if !row.removable && row.reason}
										<span class="storage-row-reason"
											><Info size={12} class="storage-row-reason-icon" aria-hidden="true" />{row.reason}</span
										>
									{/if}
								</span>
								<span class="storage-row-bytes" data-bytes={row.bytes}>{fmtBytes(row.bytes)}</span>
							</li>
						{/each}
					</ul>
					</div>
					{/if}
				</div>
			{/each}
		{:else if scan}
			<p class="text-xs text-gray-400">Nothing is stored on this device yet.</p>
		{/if}
	</div>

	{#snippet footer()}
		<!-- names the bytes about to be freed, because "3 items" is not the question -->
		<div class="flex w-full flex-wrap items-center justify-end gap-2">
			<span id="storage-selection" class="mr-auto text-xs text-gray-400">
				{#if pickedRows.length}
					{pickedRows.length}
					{pickedRows.length === 1 ? 'item' : 'items'} selected · about
					<strong>{fmtBytes(freeable)}</strong> would be freed
				{:else}
					Tick what you want gone. Nothing is removed until you press Reclaim.
				{/if}
			</span>
			<Button
				id="storage-reclaim"
				size="xs"
				color="red"
				disabled={!pickedRows.length || busy}
				onclick={reclaim}
			>
				<Trash2 size={14} class="mr-1" aria-hidden="true" />{busy ? 'Reclaiming…' : 'Reclaim'}
			</Button>
			<Button id="storage-close" size="xs" color="alternative" onclick={() => storageModalOpen.set(false)}>
				Close
			</Button>
		</div>
	{/snippet}
</Modal>

<style>
	/* Owns its surface explicitly rather than through `ui-panel`: `@apply`-built
	   utilities are compiled onto the CLASS, so theme.css's literal `.bg-gray-800`
	   remap never sees them and a themed panel would stay dark everywhere. */
	.storage-bar {
		height: 6px;
		border-radius: 3px;
		overflow: hidden;
		background: var(--surface-2, #374151);
	}
	.storage-bar-fill {
		height: 100%;
		background: var(--accent, #2563eb);
	}
	/* THE PAINT MUST FOLLOW `:disabled`, BECAUSE THE CLASS STRING DOES NOT.

	   The first pass here read the symptom right and the cause wrong. flowbite's Button
	   theme does paint its disabled variant `cursor-not-allowed opacity-50`
	   (buttons/theme.js:140) - but the real defect is that it never takes it OFF again.
	   `Button.svelte:34` reads

	       const { base, ... } = $derived(button({ ..., disabled: isDisabled, ... }));

	   and a DESTRUCTURING declaration evaluates its object once, so `base` is frozen with
	   whatever `disabled` happened to be at mount. The element's own `disabled={isDisabled}`
	   is a separate, genuinely reactive `$derived` - so the ATTRIBUTE tracks the state and
	   the CLASS STRING never moves.

	   Both of this panel's buttons are born disabled: the modal opens with a scan already
	   running (Rescan) and with nothing ticked (Reclaim). So both wore the blocked cursor
	   and the 50% fade PERMANENTLY. MEASURED, before this rule: with an item ticked and no
	   scan running, Reclaim reported `{disabled:false, opacity:'0.5', cursor:'not-allowed'}`
	   and Rescan the same - which is precisely the two reports ("remove .cursor-not-allowed",
	   "when any checkbox in modal selected remove opacity-50"). They are ONE bug, and the
	   round-13 `:disabled { cursor: default }` rule had fixed the only state in which that
	   class was telling the truth.

	   So the rules key off `:disabled` and `:not(:disabled)`, which is the half that is
	   reactive, rather than trying to correct a string that cannot change:

	     enabled          -> pointer, full strength. It is a live control; it must look it.
	     Rescan disabled  -> neutral cursor, FULL STRENGTH. It is disabled because the thing
	                         it does is already happening, and its own label says so
	                         ("Reading..."); a fade would repeat that in the vocabulary of
	                         refusal, which is what the blocked cursor was doing.
	     Reclaim disabled -> neutral cursor, and the fade STAYS. "Nothing is ticked yet" is a
	                         real state with no label to carry it, and the grey is what says
	                         so. This is the line the user drew: off Rescan outright, off
	                         Reclaim only once something is selected.

	   `:global` because a flowbite <Button> renders its <button> in its OWN scope, so a
	   plain scoped selector never lands on it; UNLAYERED, because that beats a Tailwind
	   utility whatever the specificity. `.tp-check:disabled` in ui.css settled on
	   `cursor: default` for a disabled control for the same reason, and this follows it.

	   Scoped to these two ids on purpose. The flowbite defect is app-wide - every <Button>
	   whose `disabled` prop can change is wearing a stale class string somewhere - but that
	   is a survey and a shared cure, not something to guess at from inside one panel. */
	:global(#storage-rescan:disabled),
	:global(#storage-reclaim:disabled) {
		cursor: default;
	}
	:global(#storage-rescan:disabled) {
		opacity: 1;
	}
	:global(#storage-rescan:not(:disabled)),
	:global(#storage-reclaim:not(:disabled)) {
		cursor: pointer;
		opacity: 1;
	}
	.storage-link {
		font-size: 0.7rem;
		text-decoration: underline;
		color: var(--accent, #2563eb);
		background: none;
		border: none;
		padding: 0;
		cursor: pointer;
	}
	.storage-group {
		margin-bottom: 0.6rem;
		border: 1px solid var(--border, #374151);
		border-radius: 6px;
		background: var(--surface-2, #111827);
	}
	/* THE HEAD IS A HEAD. Its own surface (one step off the card's), a heavier name and a
	   rule under it while open — without those three it sat in the same visual register as
	   the rows below it and the list read as one flat run. */
	.storage-group-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0.5rem;
		font-size: 0.78rem;
		color: var(--text, #e5e7eb);
		background: var(--surface-3, #1f2937);
		border-radius: 5px 5px 0 0;
	}
	.storage-group[data-open='true'] .storage-group-head {
		border-bottom: 1px solid var(--border, #374151);
	}
	.storage-group-tick {
		display: flex;
		align-items: center;
		cursor: pointer;
	}
	.storage-group-toggle {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0;
		background: none;
		border: none;
		color: inherit;
		font: inherit;
		text-align: left;
		cursor: pointer;
	}
	/* a `class` handed to a lucide component lands on the CHILD-scope <svg>, so the
	   rotation has to be :global — the documented icon trap */
	.storage-group-toggle :global(.storage-group-chev) {
		flex: 0 0 auto;
		transition: transform 0.12s ease;
		color: var(--text-dim, #9ca3af);
	}
	.storage-group[data-open='true'] .storage-group-toggle :global(.storage-group-chev) {
		transform: rotate(90deg);
	}
	.storage-group-name {
		font-weight: 700;
		letter-spacing: 0.01em;
	}
	.storage-group-count {
		flex: 1 1 auto;
		color: var(--text-dim, #9ca3af);
		font-size: 0.7rem;
		font-weight: 400;
	}
	/* a selection must not be able to hide behind a fold */
	.storage-group-picked {
		color: var(--accent, #2563eb);
	}
	.storage-group-bytes {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
	}
	.storage-group-note {
		padding: 0.35rem 0.5rem 0.35rem 1.9rem;
		font-size: 0.68rem;
		line-height: 1.35;
		color: var(--text-dim, #9ca3af);
	}
	.storage-rows {
		border-top: 1px solid var(--border, #374151);
		max-height: 30vh;
		overflow-y: auto;
	}
	.storage-row {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
		padding: 0.3rem 0.5rem;
		font-size: 0.72rem;
		color: var(--text, #e5e7eb);
		border-bottom: 1px solid var(--border, #374151);
	}
	.storage-row:last-child {
		border-bottom: none;
	}
	.storage-row-main {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.storage-row-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.storage-row-sub {
		font-size: 0.65rem;
		color: var(--text-dim, #9ca3af);
	}
	.storage-row-reason {
		margin-top: 0.15rem;
		font-size: 0.65rem;
		line-height: 1.35;
		color: var(--text-dim, #9ca3af);
	}
	/* a `class` handed to a lucide component lands on the CHILD-scope <svg>, so a
	   scoped selector for it must be :global — the documented icon trap */
	.storage-row-reason :global(.storage-row-reason-icon) {
		display: inline-block;
		vertical-align: -2px;
		margin-right: 0.25rem;
	}
	.storage-row-bytes {
		flex: 0 0 auto;
		font-variant-numeric: tabular-nums;
		color: var(--text-dim, #9ca3af);
	}
</style>
