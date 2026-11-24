<script>
	// 102 M1 — SIMPLIFY: a percentage slider and a triangle field that follow each other, the
	// count the ask comes to (live, before anything runs), a local Preview on the object itself,
	// and Apply = one undo step that peers see as one replace. Mounted only while open (App's
	// lazy-modal idiom), so the simplifier stays out of the boot chunk.
	// Keys: arrows on the slider, type a count, Enter applies, P previews, Esc cancels.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import UiButton from '../ui/Button.svelte';
	import { simplifyDialog } from '$lib/makerDialogs';

	/** @type {any} */
	let action = $state(null);
	import('$lib/meshSimplifyAction').then((m) => (action = m));

	let open = $state(true);
	let percent = $state(50);
	let busy = $state(false);
	/** @type {{before: number, after: number, dropped: string[]} | null} */
	let shown = $state(null);
	let error = $state('');

	const target = $derived($simplifyDialog);
	const before = $derived(target?.triangles ?? 0);
	// the count the ask comes to, computed the way Apply will (per-mesh shares, clamped)
	const planned = $derived(action && target ? action.plannedSimplify(target.uuid, { percent }) : Math.round((before * percent) / 100));
	let shownPercent = $state(-1);
	const previewStale = $derived(!!shown && shownPercent !== percent);

	// the dialog's own close (outside click, its X) is a Cancel
	$effect(() => {
		if (!open) close();
	});

	const fmt = (/** @type {number} */ n) => Number(n || 0).toLocaleString('en-US');

	/** the triangle field writes the percentage back @param {Event} e */
	function onCount(e) {
		const n = Number(/** @type {HTMLInputElement} */ (e.currentTarget).value);
		if (!Number.isFinite(n) || !before) return;
		percent = Math.max(1, Math.min(100, Math.round((n / before) * 1000) / 10));
	}

	function close() {
		action?.closeSimplify();
		simplifyDialog.set(null);
	}

	async function doPreview() {
		if (!action || !target || busy) return;
		busy = true;
		error = '';
		try {
			const numbers = await action.previewSimplify(target.uuid, { percent });
			if (!numbers) error = action.simplifyBlocker(target.uuid).why || 'Nothing to preview.';
			shown = numbers;
			shownPercent = percent;
		} catch (e) {
			error = 'Preview failed: ' + String(/** @type {any} */ (e)?.message ?? e);
		} finally {
			busy = false;
		}
	}

	async function doApply() {
		if (!action || !target || busy) return;
		busy = true;
		error = '';
		try {
			const result = await action.applySimplify(target.uuid, { percent }, { bake: !!target.bake });
			if (result?.refused) {
				error = result.refused;
				return;
			}
			simplifyDialog.set(null);
		} catch (e) {
			error = 'Simplify failed: ' + String(/** @type {any} */ (e)?.message ?? e);
		} finally {
			busy = false;
		}
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		const typing = /** @type {any} */ (e.target)?.type === 'number';
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			doApply();
		} else if ((e.key === 'p' || e.key === 'P') && !typing && !e.ctrlKey && !e.metaKey) {
			e.preventDefault();
			doPreview();
		}
	}
</script>

<ModalDialog title={'Simplify "' + (target?.name ?? '') + '"'} bind:open modal={false} onkeydown={onKey} oncancel={close} width="sm">
	<div id="simplify-dialog" class="flex flex-col gap-3 text-sm" data-before={before} data-planned={planned}>
		<p class="text-xs opacity-80">
			Fewer triangles, same look: UVs, normals, vertex colours, skin weights and material slots are kept. One undo step; everyone in the session sees the result.
		</p>
		<label class="flex items-center gap-2" title="How much of the model to keep (arrow keys step 1 %, Page Up/Down 10 %)">
			<span class="w-16 shrink-0 text-xs">Keep</span>
			<input id="simplify-percent" class="grow" type="range" min="1" max="100" step="1" bind:value={percent} aria-label="Percentage of triangles to keep" />
			<span class="w-12 text-right tabular-nums" id="simplify-percent-label">{percent} %</span>
		</label>
		<label class="flex items-center gap-2" title="Or type the triangle count you want (it sets the percentage)">
			<span class="w-16 shrink-0 text-xs">Triangles</span>
			<input id="simplify-count" class="ui-input grow" type="number" min="4" max={before} value={planned} onchange={onCount} aria-label="Target triangle count" />
		</label>
		<div id="simplify-count-line" class="text-xs tabular-nums opacity-80" aria-live="polite">
			{fmt(before)} → about {fmt(planned)} triangles
			{#if shown && !previewStale}
				<span id="simplify-preview-count">· preview: {fmt(shown.after)}</span>
			{:else if shown}
				<span class="opacity-70">· preview is for another value</span>
			{/if}
		</div>
		{#if target?.bake}
			<p class="text-xs opacity-80">The shape is baked to a mesh first: its Geometry settings lock.</p>
		{/if}
		{#if error}
			<p id="simplify-error" class="text-xs text-warn-text" role="alert">{error}</p>
		{/if}
		<div class="flex justify-end gap-2">
			<UiButton id="simplify-cancel" size="sm" variant="ghost" title="Close without changing anything (Esc)" onclick={close}>Cancel</UiButton>
			<UiButton id="simplify-preview" size="sm" variant="outline" icon="eye" disabled={busy || !action} title="Show the result on the object, only on your screen (P)" onclick={doPreview}>Preview</UiButton>
			<UiButton id="simplify-apply" size="sm" variant="primary" icon="check" disabled={busy || !action} title="Simplify for everyone — one undo step (Enter)" onclick={doApply}>{busy ? 'Working…' : 'Apply'}</UiButton>
		</div>
	</div>
</ModalDialog>
