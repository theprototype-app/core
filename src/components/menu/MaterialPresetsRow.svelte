<script>
	// 37 R5: Inspector ▸ Material — the PRESET SWATCH ROW. Its own file so the Inspector
	// carries one line for it (the settings hot-spot rule; 37-multiselect edits the same
	// section). Click a swatch = apply it to every selected object (the Inspector's material
	// fan: shader-driven members are skipped with its counted toast, N objects = ONE undo);
	// "Save" snapshots the primary object's look into YOUR library; the pencil toggles
	// rename / delete / export on your own swatches; a peer's library shows below yours, and
	// any of their swatches applies or saves as a copy. Colours are theme tokens only.
	import { Plus, Pencil, Check, X, Trash2, Download, Upload, Copy } from '@lucide/svelte';
	import { selectedObject } from '../../stores/sceneStore';
	import { showToast } from '../../stores/appStore';
	import { nameOf } from '$lib/lockControl';
	import { showConfirm } from '$lib/confirmDialog';
	import {
		materialPresets,
		peerMaterialPresets,
		starterPresets,
		resolvePreset,
		applyMaterialPreset,
		lookOfMaterial,
		saveMaterialPreset,
		saveObjectMaterialAsPreset,
		renameMaterialPreset,
		deleteMaterialPreset,
		exportMaterialPreset,
		importMaterialPreset
	} from '$lib/materialPresets';
	import { sameLook, swatchLayers, NAME_MAX } from '$lib/materialPresetsCore';

	/** @type {{ material: any, count?: number, fan: (label: string, fn: (object: any) => void) => void, primaryUuid?: string }} */
	let { material, count = 0, fan, primaryUuid = '' } = $props();

	const starters = starterPresets();

	/** the primary object's look now (re-read on every Inspector poke: `material` is a fresh snapshot) */
	const look = $derived(material?.ref ? lookOfMaterial(material.ref) : null);

	/** resolved starters, once (their procedural maps are generated on first use) */
	const resolvedStarters = starters.map((s) => ({ ...s, resolved: resolvePreset(s.preset) }));

	/** @param {any} resolved */
	const isActive = (resolved) => !!look && !!resolved && sameLook(look, resolved);

	let editing = $state(false);
	/** @type {{mode: 'save'|'rename', from?: string, name: string} | null} */
	let naming = $state(null);
	let nameError = $state('');

	/** @param {any} preset @param {string} label */
	function apply(preset, label) {
		fan('Material preset: ' + label, (object) => applyMaterialPreset(object.uuid, preset));
		selectedObject.update((s) => s); // the colour picker re-reads the new colour
	}

	/** CSS background for a swatch: the map (tinted by the colour) under the lit-sphere shading
	 * @param {any} resolved */
	function swatchStyle(resolved) {
		if (!resolved) return '';
		const layers = swatchLayers(resolved);
		if (!resolved.map) return layers.join(', ');
		// the map multiplies the colour (exactly what the material does), under the shading
		const color = resolved.color ?? '#ffffff';
		return [...layers.slice(0, -1), `url("${resolved.map}") center / 220%`, `linear-gradient(${color}, ${color})`].join(', ');
	}
	/** @param {any} resolved */
	function swatchBlend(resolved) {
		if (!resolved?.map) return '';
		return [...Array(swatchLayers(resolved).length - 1).fill('normal'), 'multiply', 'normal'].join(', ');
	}

	function startSave() {
		const suggestion = look?.label && look.label !== 'Material' ? look.label : material?.ref?.name || 'My material';
		naming = { mode: 'save', name: String(suggestion).slice(0, NAME_MAX) };
		nameError = '';
	}
	/** @param {string} name */
	function startRename(name) {
		naming = { mode: 'rename', from: name, name };
		nameError = '';
	}
	async function commitName() {
		if (!naming) return;
		const name = naming.name.trim();
		if (!name) {
			nameError = 'Give it a name';
			return;
		}
		if (naming.mode === 'save') {
			if (!primaryUuid) return;
			const saved = await saveObjectMaterialAsPreset(primaryUuid, name);
			if (!saved) return;
			if (saved !== name) showToast(`Saved as “${saved}” — “${name}” was taken`);
			naming = null;
		} else {
			const renamed = await renameMaterialPreset(naming.from ?? '', name);
			if (!renamed) {
				nameError = 'That name is taken';
				return;
			}
			naming = null;
		}
	}

	/** @param {string} name */
	async function remove(name) {
		const ok = await showConfirm({
			title: 'Delete material preset?',
			message: `“${name}” leaves your library on this device. Objects already wearing it keep their look.`,
			confirmLabel: 'Delete'
		});
		if (ok) await deleteMaterialPreset(name);
	}

	/** @param {any} payload */
	function download(payload) {
		const blob = new Blob([exportMaterialPreset(payload)], { type: 'application/json' });
		const link = document.createElement('a');
		link.href = URL.createObjectURL(blob);
		link.download = String(payload.label).replace(/[^\w-]+/g, '_') + '.matpreset.json';
		link.click();
		URL.revokeObjectURL(link.href);
	}
	/** @param {Event & {currentTarget: HTMLInputElement}} event */
	async function onImport(event) {
		const input = event.currentTarget;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		try {
			const saved = await importMaterialPreset(await file.text());
			if (saved) showToast(`Imported “${saved}” into your material presets`);
		} catch {
			showToast('That file is not a material preset');
		}
	}

	/** @param {any} payload */
	async function saveCopy(payload) {
		const saved = await saveMaterialPreset(payload.label, payload);
		if (saved) showToast(`Saved “${saved}” to your material presets`);
	}

	/** keys straight on the field: panels swallow delegated keydowns (the DragRow rule)
	 * @param {HTMLInputElement} node */
	function nameKeys(node) {
		/** @param {KeyboardEvent} e */
		const onKey = (e) => {
			e.stopPropagation();
			if (e.key === 'Enter') {
				e.preventDefault();
				commitName();
			} else if (e.key === 'Escape') {
				e.preventDefault();
				naming = null;
			}
		};
		node.addEventListener('keydown', onKey);
		node.focus();
		node.select();
		return { destroy: () => node.removeEventListener('keydown', onKey) };
	}

	const peerLists = $derived(Object.entries($peerMaterialPresets).filter(([, list]) => list.length));
</script>

<div
	id="material-presets"
	class="mp-root"
	data-tour="material-presets"
	data-keywords="material preset swatch library wood metal plastic glass stone rubber neon save rename"
>
	<div class="mp-head">
		<span class="mp-title">Presets{count ? ` — applies to all ${count}` : ''}</span>
		<span class="mp-actions">
			<button
				id="material-preset-save"
				type="button"
				class="mp-icon"
				title="Save this object's material as a preset"
				aria-label="Save material as preset"
				disabled={!primaryUuid || !look}
				onclick={startSave}><Plus size={14} aria-hidden="true" /></button
			>
			<button
				id="material-preset-edit"
				type="button"
				class="mp-icon"
				aria-pressed={editing}
				title={editing ? 'Done editing your presets' : 'Rename, delete or export your presets'}
				aria-label="Edit your presets"
				onclick={() => (editing = !editing)}
				>{#if editing}<Check size={14} aria-hidden="true" />{:else}<Pencil size={14} aria-hidden="true" />{/if}</button
			>
		</span>
	</div>

	{#if naming}
		<div class="mp-naming">
			<input
				id="material-preset-name"
				class="mp-name-input"
				maxlength={NAME_MAX}
				aria-label={naming.mode === 'save' ? 'New preset name' : 'Rename preset'}
				bind:value={naming.name}
				use:nameKeys
			/>
			<button id="material-preset-name-ok" type="button" class="mp-icon" title="Save" aria-label="Confirm name" onclick={commitName}
				><Check size={14} aria-hidden="true" /></button
			>
			<button type="button" class="mp-icon" title="Cancel" aria-label="Cancel naming" onclick={() => (naming = null)}
				><X size={14} aria-hidden="true" /></button
			>
		</div>
		{#if nameError}<p class="mp-error" role="alert">{nameError}</p>{/if}
	{/if}

	<div class="mp-row" role="group" aria-label="Material presets">
		{#each resolvedStarters as s (s.id)}
			<button
				type="button"
				class="mp-swatch"
				data-preset-kind="starter"
				data-preset-name={s.label}
				aria-pressed={isActive(s.resolved)}
				title={`${s.label} — apply to the selection`}
				onclick={() => apply(s.preset, s.label)}
			>
				<span class="mp-ball" style:background={swatchStyle(s.resolved)} style:background-blend-mode={swatchBlend(s.resolved)}></span>
				<span class="mp-label">{s.label}</span>
			</button>
		{/each}
		{#each $materialPresets as p (p.name)}
			<div class="mp-mine">
				<button
					type="button"
					class="mp-swatch"
					data-preset-kind="mine"
					data-preset-name={p.name}
					aria-pressed={isActive(p.payload)}
					title={`${p.name} — apply to the selection`}
					onclick={() => apply(p.payload, p.name)}
				>
					<span class="mp-ball" style:background={swatchStyle(p.payload)} style:background-blend-mode={swatchBlend(p.payload)}></span>
					<span class="mp-label">{p.name}</span>
				</button>
				{#if editing}
					<span class="mp-tools">
						<button type="button" class="mp-mini" data-preset-rename={p.name} title="Rename" aria-label={`Rename ${p.name}`} onclick={() => startRename(p.name)}
							><Pencil size={11} aria-hidden="true" /></button
						>
						<button type="button" class="mp-mini" data-preset-export={p.name} title="Download as .matpreset.json" aria-label={`Export ${p.name}`} onclick={() => download(p.payload)}
							><Download size={11} aria-hidden="true" /></button
						>
						<button type="button" class="mp-mini mp-danger" data-preset-delete={p.name} title="Delete" aria-label={`Delete ${p.name}`} onclick={() => remove(p.name)}
							><Trash2 size={11} aria-hidden="true" /></button
						>
					</span>
				{/if}
			</div>
		{/each}
	</div>
	{#if editing}
		<div class="mp-editbar">
			<button type="button" class="ui-button-quiet" title="Import a .matpreset.json file" onclick={() => document.getElementById('material-preset-import')?.click()}>
				<Upload size={14} class="mr-1 inline" aria-hidden="true" />Import
			</button>
			<input type="file" id="material-preset-import" style="display: none" accept=".json" onchange={onImport} />
			{#if !$materialPresets.length}
				<span class="mp-hint">Save a look with + to start your own library. The starter set is built in.</span>
			{/if}
		</div>
	{/if}

	{#each peerLists as [peerId, list] (peerId)}
		<p class="mp-peer" data-preset-peer={peerId}>From {nameOf(peerId)}</p>
		<div class="mp-row" role="group" aria-label={`${nameOf(peerId)}'s material presets`}>
			{#each list as p, i (p.label + ':' + i)}
				<div class="mp-mine">
					<button
						type="button"
						class="mp-swatch"
						data-preset-kind="peer"
						data-preset-name={p.label}
						aria-pressed={isActive(p)}
						title={`${p.label} (from ${nameOf(peerId)}) — apply to the selection`}
						onclick={() => apply(p, p.label)}
					>
						<span class="mp-ball" style:background={swatchStyle(p)} style:background-blend-mode={swatchBlend(p)}></span>
						<span class="mp-label">{p.label}</span>
					</button>
					{#if editing}
						<span class="mp-tools">
							<button type="button" class="mp-mini" data-preset-copy={p.label} title="Save a copy to your presets" aria-label={`Save a copy of ${p.label}`} onclick={() => saveCopy(p)}
								><Copy size={11} aria-hidden="true" /></button
							>
						</span>
					{/if}
				</div>
			{/each}
		</div>
	{/each}
</div>

<style>
	.mp-root {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 2px 0 6px;
	}
	.mp-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0 4px;
	}
	.mp-title {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--muted, #9ca3af);
	}
	.mp-actions {
		display: inline-flex;
		gap: 2px;
	}
	.mp-icon,
	.mp-mini {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		border-radius: 4px;
		color: var(--text-2, #d1d5db);
		background: transparent;
	}
	.mp-icon {
		width: 22px;
		height: 22px;
	}
	.mp-icon:hover:not(:disabled),
	.mp-mini:hover {
		background: var(--hover, #374151);
	}
	.mp-icon:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.mp-icon[aria-pressed='true'] {
		background: var(--accent-fill, var(--accent, #2563eb));
		color: var(--on-accent, #fff);
	}
	.mp-row {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 4px;
		padding: 0 2px;
	}
	.mp-mine {
		position: relative;
		display: inline-flex;
		flex-direction: column;
		align-items: center;
	}
	.mp-swatch {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		width: 44px;
		padding: 3px 0 2px;
		border-radius: 6px;
		background: transparent;
		border: 1px solid transparent;
		color: var(--text-2, #d1d5db);
	}
	.mp-swatch:hover {
		background: var(--hover, #374151);
	}
	.mp-swatch:focus-visible {
		outline: 2px solid var(--accent, #2563eb);
		outline-offset: 1px;
	}
	.mp-swatch[aria-pressed='true'] {
		border-color: var(--accent, #2563eb);
		background: var(--surface-2, #1f2937);
	}
	.mp-ball {
		display: block;
		width: 30px;
		height: 30px;
		border-radius: 999px;
		box-shadow: 0 0 0 1px var(--border, #4b5563);
		/* glass / anything see-through shows a checker behind it */
		background-color: var(--surface-3, #374151);
	}
	.mp-label {
		max-width: 42px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 9px;
		line-height: 1.1;
	}
	.mp-tools {
		display: inline-flex;
		gap: 1px;
		margin-top: 1px;
	}
	.mp-mini {
		width: 15px;
		height: 15px;
	}
	.mp-danger {
		color: var(--icon-danger, #f87171);
	}
	.mp-naming {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 0 4px;
	}
	.mp-name-input {
		flex: 1;
		min-width: 0;
		height: 22px;
		padding: 0 6px;
		font-size: 12px;
		border-radius: 4px;
		border: 1px solid var(--border, #4b5563);
		background: var(--field, #111827);
		color: var(--text, #f3f4f6);
	}
	.mp-name-input:focus {
		outline: 1px solid var(--accent, #2563eb);
	}
	.mp-error {
		padding: 0 6px;
		font-size: 10px;
		color: var(--ink-bad, #f87171);
	}
	.mp-editbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 2px 4px;
	}
	.mp-hint {
		font-size: 10px;
		color: var(--muted, #9ca3af);
	}
	.mp-peer {
		margin-top: 4px;
		padding: 0 4px;
		font-size: 10px;
		color: var(--muted, #9ca3af);
	}
</style>
