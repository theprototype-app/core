<script>
	// 63-publish (row 13) — THE PUBLISH CHECK: a short list of what a visitor would hit, above the
	// cloud plugin's Publish flow, each row with a fix button where one exists. It WARNS, it never
	// blocks: the Publish button below it works whatever the list says (checkCore.summarize gives
	// 'publish' blocking 0). Loads with the Publish / Export modal (which App mounts lazily), so
	// boot pays nothing; the check itself starts a moment after the tab draws, so the tab is never
	// slower to open.
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import CheckList from '../export/CheckList.svelte';
	import Button from '../ui/Button.svelte';
	import { publishExportOpen } from '$lib/export/exportStores.js';
	import { runChecks, summarize } from '$lib/export/checkCore.js';
	import { SCENE_RULES } from '$lib/export/sceneChecks.js';

	/** @type {{id?: string}} */
	let { id = 'publish-check' } = $props();

	/** @type {import('$lib/export/checkCore.js').CheckRow[]} */
	let rows = $state([]);
	let busy = $state(true);
	let ran = $state(false);
	/** @type {any} */
	let ctx = null;
	const counts = $derived(summarize(rows, 'publish'));

	async function check() {
		busy = true;
		try {
			const { gatherSceneFacts } = await import('$lib/export/sceneFacts.js');
			ctx = { target: 'publish', phone: true, scene: await gatherSceneFacts({ target: 'publish' }) };
			rows = await runChecks(SCENE_RULES, ctx);
		} catch (e) {
			rows = [{ id: 'check-failed', owner: 'scene', severity: 'info', title: 'The check could not run', detail: String(/** @type {any} */ (e)?.message ?? e).slice(0, 200) }];
		} finally {
			busy = false;
			ran = true;
		}
	}

	/** @param {import('$lib/export/checkCore.js').CheckRow} row */
	async function fix(row) {
		busy = true;
		const { runFix } = await import('$lib/export/checkFixes.js');
		const next = await runFix(row, ctx);
		if (next === 'leave') {
			busy = false;
			publishExportOpen.set(false);
			return;
		}
		await check();
	}

	/** @param {string} uuid */
	async function select(uuid) {
		const { applySelectionSet } = await import('$lib/objectActions');
		applySelectionSet([uuid], true);
		publishExportOpen.set(false);
	}

	onMount(() => {
		const t = setTimeout(() => get(publishExportOpen) && check(), 150);
		return () => clearTimeout(t);
	});
</script>

<section {id} class="pc" aria-labelledby="{id}-head" data-ran={ran ? 'true' : 'false'} data-errors={counts.error} data-warnings={counts.warn}>
	<div class="pc-head">
		<h3 id="{id}-head">Before you publish</h3>
		<span class="pc-sum" aria-live="polite">
			{#if busy && !ran}Checking…{:else if !rows.length}All clear{:else}{rows.length} to look at — you can still publish{/if}
		</span>
		<Button variant="ghost" size="sm" icon="refresh-cw" id="{id}-again" title="Check the scene again" disabled={busy} onclick={check}>Check again</Button>
	</div>
	<CheckList id="{id}-list" {rows} {busy} onfix={fix} onselect={select} emptyText="Nothing a visitor would trip over." />
</section>

<style>
	.pc {
		margin-bottom: var(--space-3, 12px);
	}
	.pc-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
		margin-bottom: 6px;
	}
	.pc-head h3 {
		margin: 0;
		font-size: var(--fs-body, 13px);
		font-weight: 600;
	}
	.pc-sum {
		flex: 1 1 auto;
		color: var(--text-2);
		font-size: 12px;
	}
</style>
