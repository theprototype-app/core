<script>
	// 102 M2 — EXPORT FOR 3D PRINT (STL / 3MF) AND AR (USDZ). Mounted only while open (App's
	// lazy-modal idiom): the writers, fflate's zip and three's USDZExporter load with it.
	//  · print: the size it will print at in millimetres (scene metres × 1000 × scale), a scale
	//    field and a "longest side" field that follow each other, and the manifold warning
	//    (open edges counted; it never blocks — slicers repair small holes).
	//  · AR: the file is built first so its size is shown, then downloaded; textures capped at 2k.
	// Keys: Enter exports / downloads, Esc closes, 1 / 2 / 3 pick STL / 3MF / USDZ.
	import ModalDialog from '../ui/ModalDialog.svelte';
	import UiButton from '../ui/Button.svelte';
	import { export3dDialog } from '$lib/makerDialogs';

	/** @type {any} */
	let action = $state(null);
	/** @type {any} */
	let core = $state(null);
	Promise.all([import('$lib/export3d/export3dAction'), import('$lib/export3d/print3dCore')]).then(([a, c]) => {
		action = a;
		core = c;
	});

	let open = $state(true);
	const target = $derived($export3dDialog);
	let format = $state(/** @type {'stl'|'3mf'|'usdz'} */ ($export3dDialog?.format ?? 'stl'));
	let scope = $state(/** @type {'selection'|'scene'} */ ($export3dDialog?.uuids ? 'selection' : 'scene'));
	let scale = $state(1);
	let busy = $state(false);
	let error = $state('');
	/** @type {Uint8Array | null} */
	let usdz = $state.raw(null);

	const uuids = $derived(scope === 'selection' ? (target?.uuids ?? null) : null);
	// the parts are read once per scope (a world-space copy — the dialog never re-reads per keystroke)
	const parts = $derived(action ? action.collectParts(uuids) : []);
	const facts = $derived(action ? action.printFacts(parts) : null);
	const printMm = $derived(facts ? facts.sizeMm.map((/** @type {number} */ v) => v * scale) : [0, 0, 0]);
	const longest = $derived(Math.max(...printMm));
	const name = $derived(scope === 'selection' ? (target?.name ?? 'selection') : 'scene');

	$effect(() => {
		if (!open) close();
	});
	// a new scope or format invalidates a built USDZ
	$effect(() => {
		void scope;
		void format;
		usdz = null;
	});

	const mm = (/** @type {number} */ v) => (v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1));

	function close() {
		export3dDialog.set(null);
	}

	/** @param {Event} e */
	function onLongest(e) {
		const want = Number(/** @type {HTMLInputElement} */ (e.currentTarget).value);
		if (core && facts && want > 0) scale = core.scaleForLongestSide(facts.sizeMetres, want);
	}

	async function run() {
		if (!action || busy) return;
		error = '';
		if (!parts.length) {
			error = 'Nothing to export: no meshes in ' + (scope === 'selection' ? 'the selection' : 'the scene') + '.';
			return;
		}
		busy = true;
		try {
			if (format === 'usdz') {
				if (!usdz) {
					usdz = await action.usdzBytes(uuids);
					return; // first press builds and shows the size; the second downloads
				}
				action.saveUsdz(usdz, name);
				close();
				return;
			}
			if (await action.exportPrint(format, parts, { scale, name })) close();
		} catch (e) {
			error = 'Export failed: ' + String(/** @type {any} */ (e)?.message ?? e);
		} finally {
			busy = false;
		}
	}

	/** @param {KeyboardEvent} e */
	function onKey(e) {
		const typing = /** @type {any} */ (e.target)?.tagName === 'INPUT' && /** @type {any} */ (e.target).type !== 'radio';
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		} else if (e.key === 'Enter') {
			e.preventDefault();
			run();
		} else if (!typing && ['1', '2', '3'].includes(e.key)) {
			e.preventDefault();
			format = /** @type {any} */ (['stl', '3mf', 'usdz'][Number(e.key) - 1]);
		}
	}

	const FORMATS = [
		{ id: 'stl', label: 'STL', tip: 'Binary STL (1): one mesh, millimetres — every slicer reads it. No colour.' },
		{ id: '3mf', label: '3MF', tip: '3MF (2): millimetres, one object per part with its colour — for multi-colour printers and modern slicers.' },
		{ id: 'usdz', label: 'USDZ (AR)', tip: 'USDZ (3): for AR Quick Look on iPhone and iPad — place it in your room. Textures capped at 2048 px.' }
	];
</script>

<ModalDialog title={format === 'usdz' ? 'Export for AR' : 'Export for 3D printing'} bind:open modal={false} onkeydown={onKey} oncancel={close} width="sm">
	<div id="export3d-dialog" class="flex flex-col gap-3 text-sm" data-format={format} data-parts={facts?.parts ?? 0} data-open-edges={facts?.openEdges ?? 0}>
		<div class="tp-seg self-start" role="group" aria-label="File format">
			{#each FORMATS as f (f.id)}
				<button type="button" class="tp-seg-btn" id={'export3d-format-' + f.id} aria-pressed={format === f.id} title={f.tip} onclick={() => (format = /** @type {any} */ (f.id))}>{f.label}</button>
			{/each}
		</div>
		<div class="tp-seg self-start" role="group" aria-label="What to export">
			<button type="button" class="tp-seg-btn" id="export3d-scope-selection" aria-pressed={scope === 'selection'} disabled={!target?.uuids} title={target?.uuids ? 'Only the selected objects, where they stand' : 'Select something first to export only that'} onclick={() => (scope = 'selection')}>Selection</button>
			<button type="button" class="tp-seg-btn" id="export3d-scope-scene" aria-pressed={scope === 'scene'} title="Every visible mesh in the scene" onclick={() => (scope = 'scene')}>Whole scene</button>
		</div>

		{#if facts}
			<div id="export3d-facts" class="text-xs tabular-nums opacity-80">
				{facts.parts} part{facts.parts === 1 ? '' : 's'} · {facts.triangles.toLocaleString('en-US')} triangles
			</div>
			{#if format !== 'usdz'}
				<div id="export3d-size" class="text-xs tabular-nums" data-longest-mm={Math.round(longest * 10) / 10}>
					Prints at {mm(printMm[0])} × {mm(printMm[2])} × {mm(printMm[1])} mm (width × depth × height)
				</div>
				<div class="flex gap-2">
					<label class="flex items-center gap-2" title="Multiply the size (1 = one scene metre is 1000 mm)">
						<span class="text-xs">Scale</span>
						<input id="export3d-scale" class="ui-input w-24" type="number" min="0.0001" step="0.01" bind:value={scale} aria-label="Scale factor" />
					</label>
					<label class="flex items-center gap-2" title="Or type how long the longest side should be — it sets the scale">
						<span class="text-xs">Longest side</span>
						<input id="export3d-longest" class="ui-input w-24" type="number" min="0.1" step="1" value={Math.round(longest * 10) / 10} onchange={onLongest} aria-label="Longest side in millimetres" />
						<span class="text-xs">mm</span>
					</label>
				</div>
				{#if facts.openEdges > 0}
					<p id="export3d-manifold" class="text-xs text-warn-text" role="status">
						Not watertight: {facts.openEdges.toLocaleString('en-US')} open edge{facts.openEdges === 1 ? '' : 's'}. Most slicers repair small holes; for a clean print close them first (Mesh ▸ edit, or a boolean union).
					</p>
				{:else if facts.parts}
					<p id="export3d-manifold" class="text-xs opacity-70" role="status">Watertight: no open edges.</p>
				{/if}
			{:else if usdz}
				<p id="export3d-usdz-size" class="text-xs tabular-nums" data-bytes={usdz.byteLength}>Ready: {action.sizeLabel(usdz.byteLength)}. Download it, or open it on an iPhone or iPad to place it in your room.</p>
			{:else}
				<p class="text-xs opacity-70">Builds the file first and shows its size.</p>
			{/if}
		{/if}
		{#if error}
			<p id="export3d-error" class="text-xs text-warn-text" role="alert">{error}</p>
		{/if}
		<div class="flex justify-end gap-2">
			<UiButton id="export3d-cancel" size="sm" variant="ghost" title="Close (Esc)" onclick={close}>Cancel</UiButton>
			<UiButton
				id="export3d-run"
				size="sm"
				variant="primary"
				icon={format === 'usdz' && !usdz ? 'package' : 'download'}
				disabled={busy || !action}
				title={format === 'usdz' && !usdz ? 'Build the USDZ and show its size (Enter)' : 'Download the file (Enter)'}
				onclick={run}>{busy ? 'Working…' : format === 'usdz' && !usdz ? 'Build' : 'Download'}</UiButton
			>
		</div>
	</div>
</ModalDialog>
