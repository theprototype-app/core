<script>
	// loose-scenes fix (bug 2a) — "these are already in your library".
	//
	// A blocking decision, so it is a TRULY modal dialog, the one exception the app's
	// modal rule keeps (ConfirmModal is the other, and this file is deliberately built
	// on its shape: LEGACY mode, a modal with a bound `open` and a `$:` watcher,
	// because it has no onopen/onclose and an outside click / Esc flips the binding —
	// which must resolve as CANCEL rather than leave the import's promise dangling).
	//
	// The rows are GROUPED by scene vs everything else, because the two carry different
	// promises: a scene can be copied (fresh uuid, fresh hash, its own history) and no
	// other kind can, since identical bytes ARE one file. Saying that once per group
	// beats a disabled checkbox with no explanation on every row.
	// 38 R7: on the shared ModalDialog (WindowChrome size="modal"), still TRULY modal; the
	// title moved into the chrome, the two answers into its footer, the ticks onto the kit
	// Checkbox (a real <input>, so the suites and the keyboard read it as before).
	import ModalDialog from '../ui/ModalDialog.svelte';
	import Button from '../ui/Button.svelte';
	import Checkbox from '../ui/Checkbox.svelte';
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
	<ModalDialog bind:open modal frame={false} width="md" title="Already in your library">
		<p class="dup-lead">
			{rows.length}
			{rows.length === 1 ? 'file is' : 'files are'} byte-for-byte identical to
			{rows.length === 1 ? 'a file' : 'files'} you already have{$duplicateImportDialog.group
				? ' (' + $duplicateImportDialog.group + ')'
				: ''}. Nothing has been imported yet.
		</p>

		{#if scenes.length}
			<section class="dup-group">
				<div class="dup-head">
					<h3 class="dup-label">Scenes — a real copy is possible</h3>
					<label class="dup-all">
						<Checkbox id="dup-select-all" checked={allPicked} onchange={toggleAll} />
						Select all
					</label>
				</div>
				<ul class="dup-list">
					{#each scenes as row (row.hash)}
						<li class="dup-row" data-dup-hash={row.hash}>
							<Checkbox
								label={'Import a copy of ' + row.name}
								checked={picked.has(row.hash)}
								onchange={() => toggle(row.hash)}
							/>
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
			</section>
		{/if}

		{#if others.length}
			<section class="dup-group">
				<h3 class="dup-label">Other files — the same file, not a copy</h3>
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
				<p class="dup-note">A file is identified by its contents, so two identical files of these kinds are one file. These will be left as they are.</p>
			</section>
		{/if}

		<label class="dup-remember">
			<Checkbox id="dup-remember" checked={remember} onchange={(/** @type {boolean} */ on) => (remember = on)} />
			Always do this — don't ask again (Settings ▸ Files)
		</label>

		{#snippet footer()}
			<Button id="dup-import-copies" variant="primary" disabled={!picked.size} onclick={() => finish('copy')}>
				Import as copies
			</Button>
			<Button id="dup-skip" variant="outline" onclick={() => finish('skip')}>Skip them</Button>
		{/snippet}
	</ModalDialog>
{/if}

<style>
	.dup-lead {
		margin: 0 0 var(--space-4);
		font-size: var(--fs-body);
		line-height: 1.5;
		color: var(--text-2);
	}
	.dup-group {
		margin-bottom: var(--space-4);
	}
	.dup-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-2);
	}
	/* the SPEC section header: uppercase, faint, 12px */
	.dup-label {
		margin: 0 0 var(--space-2);
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-faint);
	}
	.dup-head .dup-label {
		margin-bottom: 0;
	}
	.dup-all,
	.dup-remember {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--fs-desc);
		color: var(--text-muted);
		cursor: pointer;
	}
	.dup-list {
		max-height: 34vh;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		list-style: none;
		border: 1px solid var(--border);
		border-radius: var(--radius-card);
		background: var(--surface-2);
	}
	.dup-row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 40px;
		padding: var(--space-1) var(--space-3);
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.dup-row + .dup-row {
		border-top: 1px solid var(--border);
	}
	.dup-name {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.dup-name--wide {
		/* no checkbox on this row: start where a checked row's name starts, so the two
		   groups' names and sizes still line up with each other */
		margin-left: 30px;
	}
	.dup-meta {
		flex: 0 0 auto;
		font-family: var(--font-ui-mono);
		font-size: var(--fs-badge);
		color: var(--text-faint);
	}
	.dup-reveal {
		flex: 0 0 auto;
		padding: var(--space-1) var(--space-2);
		border: 0;
		border-radius: var(--radius-input);
		background: none;
		font: inherit;
		color: var(--accent-text);
		cursor: pointer;
	}
	.dup-reveal:hover {
		background: var(--surface-hover);
	}
	.dup-note {
		margin: var(--space-2) 0 0;
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
</style>
