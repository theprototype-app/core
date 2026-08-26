<script>
	// loose-scenes fix (bug 2a) — "these are already in your library".
	//
	// A blocking decision, so it is a TRULY modal dialog, the one exception the app's
	// modal rule keeps (ConfirmModal is the other, and this file is deliberately built
	// on its shape: LEGACY mode, flowbite Modal with a bound `open` and a `$:` watcher,
	// because Modal has no onopen/onclose and an outside click / Esc flips the binding —
	// which must resolve as CANCEL rather than leave the import's promise dangling).
	//
	// The rows are GROUPED by scene vs everything else, because the two carry different
	// promises: a scene can be copied (fresh uuid, fresh hash, its own history) and no
	// other kind can, since identical bytes ARE one file. Saying that once per group
	// beats a disabled checkbox with no explanation on every row.
	import { Modal, Button } from 'flowbite-svelte';
	import {
		duplicateImportDialog,
		resolveDuplicateImport,
		duplicateImportMode,
		canCopy
	} from '$lib/importDuplicates';
	import { revealItem } from '$lib/explorer';

	let open = false;
	/** @type {Set<string>} the hashes ticked for "Import as copies" */
	let picked = new Set();
	/** @type {any[] | null} the rows the ticks below were seeded from */
	let lastRows = null;
	let remember = false;

	$: open = !!$duplicateImportDialog;
	// outside-close (backdrop / Esc) with a request still pending = skip them
	$: if (!open && $duplicateImportDialog) resolveDuplicateImport(null);

	// seed the ticks once per REQUEST (never per render, or every keystroke on the
	// remember box would re-tick rows the user had just cleared). Copyable rows start
	// ticked: the button they belong to is the non-default action, so the ticks are
	// there to be REMOVED from.
	$: if ($duplicateImportDialog && $duplicateImportDialog.rows !== lastRows) {
		lastRows = $duplicateImportDialog.rows;
		picked = new Set($duplicateImportDialog.rows.filter(canCopy).map((/** @type {any} */ r) => r.hash));
		remember = false;
	}

	$: rows = $duplicateImportDialog?.rows ?? [];
	$: scenes = rows.filter(canCopy);
	$: others = rows.filter((/** @type {any} */ r) => !canCopy(r));
	$: allPicked = scenes.length > 0 && scenes.every((/** @type {any} */ r) => picked.has(r.hash));

	/** @param {string} hash */
	function toggle(hash) {
		const next = new Set(picked);
		if (next.has(hash)) next.delete(hash);
		else next.add(hash);
		picked = next;
	}

	function toggleAll() {
		picked = allPicked ? new Set() : new Set(scenes.map((/** @type {any} */ r) => r.hash));
	}

	/** @param {'skip' | 'copy'} action */
	function finish(action) {
		// "don't ask again" writes the SAME key the Files setting does — there is one
		// rule, reachable from two places, and the modal is where you find out it exists
		if (remember) duplicateImportMode.set(action === 'copy' ? 'copy' : 'skip');
		resolveDuplicateImport({ action, hashes: [...picked] });
	}

	/** @param {any} row */
	function reveal(row) {
		revealItem(row.existing?.id);
		resolveDuplicateImport({ action: 'skip', hashes: [] });
	}

	/** @param {number} bytes */
	function size(bytes) {
		const kb = (Number(bytes) || 0) / 1024;
		return kb < 1024 ? Math.max(1, Math.round(kb)) + ' KB' : (kb / 1024).toFixed(1) + ' MB';
	}
</script>

{#if $duplicateImportDialog}
	<Modal bind:open size="md" autoclose={false} class="w-full">
		<h3 class="mb-1 text-lg font-semibold text-gray-900 dark:text-white">
			Already in your library
		</h3>
		<p class="mb-3 text-sm text-gray-600 dark:text-gray-300">
			{rows.length}
			{rows.length === 1 ? 'file is' : 'files are'} byte-for-byte identical to
			{rows.length === 1 ? 'a file' : 'files'} you already have{$duplicateImportDialog.group
				? ' (' + $duplicateImportDialog.group + ')'
				: ''}. Nothing has been imported yet.
		</p>

		{#if scenes.length}
			<div class="mb-3">
				<div class="mb-1 flex items-center justify-between">
					<p class="ui-section-label !mb-0">Scenes — a real copy is possible</p>
					<label class="flex cursor-pointer items-center gap-1.5 text-xs text-gray-400">
						<input
							id="dup-select-all"
							class="tp-check"
							type="checkbox"
							checked={allPicked}
							on:change={toggleAll} />
						Select all
					</label>
				</div>
				<ul class="dup-list">
					{#each scenes as row (row.hash)}
						<li class="dup-row" data-dup-hash={row.hash}>
							<input
								class="tp-check"
								type="checkbox"
								aria-label={'Import a copy of ' + row.name}
								checked={picked.has(row.hash)}
								on:change={() => toggle(row.hash)} />
							<span class="dup-name" title={row.name}>{row.name}</span>
							<span class="dup-meta">{size(row.existing?.size ?? 0)}</span>
							<button
								type="button"
								class="dup-reveal"
								title="Show the file you already have"
								on:click={() => reveal(row)}>Reveal</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if others.length}
			<div class="mb-3">
				<p class="ui-section-label">Other files — the same file, not a copy</p>
				<ul class="dup-list">
					{#each others as row (row.hash)}
						<li class="dup-row" data-dup-hash={row.hash}>
							<span class="dup-name dup-name--wide" title={row.name}>{row.name}</span>
							<span class="dup-meta">{size(row.existing?.size ?? 0)}</span>
							<button
								type="button"
								class="dup-reveal"
								title="Show the file you already have"
								on:click={() => reveal(row)}>Reveal</button>
						</li>
					{/each}
				</ul>
				<p class="mt-1 text-xs text-gray-400">
					A file is identified by its contents, so two identical files of these kinds are
					one file. These will be left as they are.
				</p>
			</div>
		{/if}

		<label class="mb-3 flex cursor-pointer items-center gap-2 text-xs text-gray-400">
			<input id="dup-remember" class="tp-check" type="checkbox" bind:checked={remember} />
			Always do this — don't ask again (Settings ▸ Files)
		</label>

		<div class="flex justify-end gap-2">
			<Button id="dup-import-copies" color="primary" disabled={!picked.size} onclick={() => finish('copy')}>
				Import as copies
			</Button>
			<Button id="dup-skip" color="alternative" onclick={() => finish('skip')}>Skip them</Button>
		</div>
	</Modal>
{/if}

<style>
	.dup-list {
		max-height: 34vh;
		overflow-y: auto;
		border: 1px solid var(--border, #374151);
		border-radius: 6px;
		background: var(--surface-2, #111827);
	}
	.dup-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.3rem 0.5rem;
		font-size: 0.75rem;
		color: var(--text, #e5e7eb);
		border-bottom: 1px solid var(--border, #374151);
	}
	.dup-row:last-child {
		border-bottom: none;
	}
	.dup-name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dup-name--wide {
		/* no checkbox on this row — take the space it would have used, so the two
		   groups' names and sizes still line up with each other */
		margin-left: 22px;
	}
	.dup-meta {
		flex: 0 0 auto;
		color: var(--text-dim, #9ca3af);
	}
	.dup-reveal {
		flex: 0 0 auto;
		text-decoration: underline;
		color: var(--accent, #2563eb);
		background: none;
		border: none;
		cursor: pointer;
		padding: 0;
	}
</style>
