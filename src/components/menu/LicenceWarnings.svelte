<script>
	// 57 M7 — "what the licences ask" above an Export, Download or Publish: one line per asset whose
	// licence restricts use (no redistribution, non-commercial, no modification — warned first) or
	// asks for credit. A WARNING, never a block (fork F3: there is no reliable way to tell intent).
	// Renders nothing when nothing in the set asks anything.
	import { sceneRevision } from '../../stores/sceneStore';
	import { licenceWarningsFor } from '$lib/sceneLicences.js';

	/** @type {{where: 'export'|'download'|'publish', uuids?: string[] | null, id?: string}} */
	let { where, uuids = null, id = 'licence-warnings' } = $props();

	const warnings = $derived.by(() => {
		void $sceneRevision;
		return licenceWarningsFor(uuids, where);
	});
	const restricted = $derived(warnings.filter((w) => w.restricted).length);
</script>

{#if warnings.length}
	<div {id} class="lw" role="note" data-count={warnings.length} data-restricted={restricted}>
		<p class="lw-head">
			{restricted ? 'Check the licences before you share this' : 'Credit these where you share it'}
		</p>
		<ul>
			{#each warnings as w (w.uuid + w.text)}
				<li class:lw-strong={w.restricted} data-uuid={w.uuid}>{w.text}</li>
			{/each}
		</ul>
	</div>
{/if}

<style>
	.lw {
		border: 1px solid var(--ink-warn);
		border-radius: var(--radius-input);
		background: var(--surface-2);
		padding: 6px 8px;
		margin-bottom: 8px;
		font-size: 12px;
	}
	.lw-head {
		font-weight: 600;
		margin: 0 0 2px;
	}
	.lw ul {
		margin: 0;
		padding-left: 16px;
	}
	.lw-strong {
		color: var(--ink-warn);
	}
</style>
