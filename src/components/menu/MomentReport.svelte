<script>
	// 34 R1 — "Report this moment" (desktop). The data and the picture were captured when the
	// menu row was pressed (perf/moment.js captureMoment); this card only asks for the note and
	// whether to send it. Saving locally always happens; sending needs the build's endpoint.
	import { momentDraft, closeMomentReport } from '$lib/perf/moment';
	import { perfReportsOn, perfReportsAvailable } from '$lib/perf/beacon';
	import { summarize } from '$lib/perf/tpprof';

	let note = $state('');
	let send = $state(false);
	let busy = $state(false);
	/** the draft this card was last opened for (reset the fields once per draft) */
	let seen = /** @type {any} */ (null);

	$effect(() => {
		const draft = $momentDraft;
		if (draft && draft !== seen) {
			seen = draft;
			note = '';
			send = $perfReportsOn && $perfReportsAvailable;
			busy = false;
		}
	});

	const stats = $derived($momentDraft ? summarize($momentDraft.doc) : null);

	/** @param {boolean} save */
	async function answer(save) {
		if (busy) return;
		busy = true;
		await closeMomentReport(save ? { note, send: send && $perfReportsAvailable } : null);
		busy = false;
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			void answer(false);
		}
	}
</script>

{#if $momentDraft}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div id="moment-report" class="moment ui-panel" role="dialog" aria-label="Report this moment" tabindex="-1" onkeydown={onKey}>
		<p class="title">Report this moment</p>
		{#if $momentDraft.shotUrl}
			<img id="moment-shot" class="shot" src={$momentDraft.shotUrl} alt="What the viewport showed" />
		{:else}
			<p class="muted">No picture (nothing to render)</p>
		{/if}
		{#if stats}
			<p id="moment-stats" class="muted">
				Last {Math.round(stats.durationMs / 1000)} s · {stats.frames} frames · {stats.fpsP50 ?? '—'} fps median · {stats.stalls}
				stall{stats.stalls === 1 ? '' : 's'}
			</p>
		{/if}
		<label class="field">
			<span>What happened? (optional)</span>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea id="moment-note" rows="3" maxlength="1000" bind:value={note} autofocus></textarea>
		</label>
		{#if $perfReportsAvailable}
			<label class="check">
				<input id="moment-send" type="checkbox" class="tp-check" bind:checked={send} />
				<span>Send it to the developers (frame data, module versions and this picture — no account)</span>
			</label>
		{/if}
		<div class="actions">
			<button id="moment-cancel" class="btn" onclick={() => answer(false)} disabled={busy}>Cancel</button>
			<button id="moment-save" class="btn primary" onclick={() => answer(true)} disabled={busy}>
				{send && $perfReportsAvailable ? 'Save and send' : 'Save'}
			</button>
		</div>
	</div>
{/if}

<style>
	.moment {
		position: fixed;
		top: calc(var(--connect-bottom, 0px) + 72px);
		left: 50%;
		transform: translateX(-50%);
		z-index: var(--z-modal, 1100);
		width: min(420px, calc(100vw - 32px));
		display: flex;
		flex-direction: column;
		gap: 8px;
		padding: 14px;
		background: var(--surface, #1f2937);
		color: #e5e7eb;
		font-size: 13px;
	}
	.title {
		font-weight: 700;
		font-size: 15px;
	}
	.shot {
		width: 100%;
		max-height: 220px;
		object-fit: contain;
		border-radius: 6px;
		background: #000;
	}
	.muted {
		color: #9ca3af;
		font-size: 12px;
	}
	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.field textarea {
		width: 100%;
		resize: vertical;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.3);
		color: inherit;
		border: 1px solid #4b5563;
		padding: 6px;
	}
	.check {
		display: flex;
		gap: 8px;
		align-items: flex-start;
	}
	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
	.btn {
		padding: 5px 12px;
		border-radius: 6px;
		background: #374151;
	}
	.btn.primary {
		background: var(--accent, #2563eb);
		color: #fff;
	}
</style>
