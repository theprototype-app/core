<script>
	// 37 R5: Inspector ▸ Material — the PRESET SWATCH ROW. Its own file so the Inspector
	// carries one line for it (the settings hot-spot rule; 37-multiselect edits the same
	// section). Click a swatch = apply it to every selected object (the Inspector's material
	// fan: shader-driven members are skipped with its counted toast, N objects = ONE undo);
	// "Save" snapshots the primary object's look into YOUR library; the pencil toggles
	// rename / delete / export on your own swatches; a peer's library shows below yours, and
	// any of their swatches applies or saves as a copy. Built on the 38 redesign kit (Button,
	// Icon via Button) and theme tokens only — `check-tokens` reports nothing here.
	import Button from '../ui/Button.svelte';
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
		lookOfObject,
		saveMaterialPreset,
		saveObjectMaterialAsPreset,
		renameMaterialPreset,
		deleteMaterialPreset,
		exportMaterialPreset,
		importMaterialPreset
	} from '$lib/materialPresets';
	import { sameLook, swatchLayers, NAME_MAX, LOOK_DEFAULTS } from '$lib/materialPresetsCore';

	/** @type {{ material: any, count?: number, fan: (label: string, fn: (object: any) => void) => void, primaryUuid?: string }} */
	let { material, count = 0, fan, primaryUuid = '' } = $props();

	const starters = starterPresets();

	/** the primary object's look now, selection tint removed (re-read on every Inspector poke:
	 * `material` is a fresh snapshot, so reading it here is the dependency) */
	const look = $derived(material?.ref && primaryUuid ? lookOfObject(primaryUuid) : null);

	/** resolved starters, once (their procedural maps are generated on first use) */
	const resolvedStarters = starters.map((s) => ({ ...s, resolved: resolvePreset(s.preset) }));

	/** @param {any} resolved */
	const isActive = (resolved) => !!look && !!resolved && sameLook(look, resolved);

	let editing = $state(false);
	/** in edit mode a click PICKS a swatch for the toolbar instead of applying it
	 * @type {{kind: 'mine'|'peer', name: string, payload: any} | null} */
	let picked = $state(null);
	$effect(() => {
		if (!editing) picked = null;
	});
	/** @param {'mine'|'peer'} kind @param {string} name @param {any} payload */
	function pick(kind, name, payload) {
		picked = { kind, name, payload };
	}
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
		const color = resolved.color ?? LOOK_DEFAULTS.color;
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
			const entry = $materialPresets.find((p) => p.name === renamed);
			picked = entry ? { kind: 'mine', name: renamed, payload: entry.payload } : null;
			naming = null;
		}
	}

	/** @param {string} name (read before anything clears `picked`: the toolbar's name derives from it) */
	async function remove(name) {
		picked = null;
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
			<Button
				id="material-preset-save"
				variant="icon"
				size="sm"
				icon="plus"
				label="Save material as preset"
				title="Save this object's material as a preset"
				disabled={!primaryUuid || !look}
				onclick={startSave}
			/>
			<Button
				id="material-preset-edit"
				variant="icon"
				size="sm"
				icon={editing ? 'check' : 'pencil'}
				pressed={editing}
				label="Edit your presets"
				title={editing ? 'Done editing your presets' : 'Rename, delete or export your presets'}
				onclick={() => (editing = !editing)}
			/>
		</span>
	</div>

	{#if naming}
		<div class="mp-naming">
			<input
				id="material-preset-name"
				class="mp-name-input"
				maxlength={NAME_MAX}
				autocomplete="off"
				spellcheck="false"
				aria-label={naming.mode === 'save' ? 'New preset name' : 'Rename preset'}
				bind:value={naming.name}
				use:nameKeys
			/>
			<Button id="material-preset-name-ok" variant="icon" size="sm" icon="check" label="Confirm name" title="Save" onclick={commitName} />
			<Button variant="icon" size="sm" icon="x" label="Cancel naming" title="Cancel" onclick={() => (naming = null)} />
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
					aria-pressed={editing ? picked?.kind === 'mine' && picked.name === p.name : isActive(p.payload)}
					title={editing ? `${p.name} — pick to rename, export or delete` : `${p.name} — apply to the selection`}
					onclick={() => (editing ? pick('mine', p.name, p.payload) : apply(p.payload, p.name))}
				>
					<span class="mp-ball" style:background={swatchStyle(p.payload)} style:background-blend-mode={swatchBlend(p.payload)}></span>
					<span class="mp-label">{p.name}</span>
				</button>
			</div>
		{/each}
	</div>
	{#if editing}
		<div class="mp-editbar" id="material-preset-toolbar">
			{#if picked?.kind === 'mine'}
				{@const name = picked.name}
				<span class="mp-picked">{name}</span>
				<Button variant="icon" size="sm" icon="pencil" data-preset-rename={name} label={`Rename ${name}`} title="Rename" onclick={() => startRename(name)} />
				<Button variant="icon" size="sm" icon="download" data-preset-export={name} label={`Export ${name}`} title="Download as .matpreset.json" onclick={() => download(picked?.payload)} />
				<Button variant="icon" size="sm" icon="trash-2" data-preset-delete={name} label={`Delete ${name}`} title="Delete" onclick={() => remove(name)} />
			{:else if picked?.kind === 'peer'}
				{@const copy = picked.payload}
				<span class="mp-picked">{picked.name}</span>
				<Button variant="outline" size="sm" icon="copy" data-preset-copy={picked.name} title="Save a copy to your presets" onclick={() => saveCopy(copy)}>Save a copy</Button>
			{:else}
				<span class="mp-hint">{$materialPresets.length || peerLists.length ? 'Pick one of your presets to rename, export or delete it.' : 'Save a look with + to start your own library. The starter set is built in.'}</span>
			{/if}
		</div>
		<div class="mp-editbar">
			<Button variant="outline" size="sm" icon="folder-input" title="Import a .matpreset.json file" onclick={() => document.getElementById('material-preset-import')?.click()}>Import</Button>
			<input type="file" id="material-preset-import" style="display: none" accept=".json" onchange={onImport} />
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
						aria-pressed={editing ? picked?.kind === 'peer' && picked.payload === p : isActive(p)}
						title={editing ? `${p.label} — pick to save a copy` : `${p.label} (from ${nameOf(peerId)}) — apply to the selection`}
						onclick={() => (editing ? pick('peer', p.label, p) : apply(p, p.label))}
					>
						<span class="mp-ball" style:background={swatchStyle(p)} style:background-blend-mode={swatchBlend(p)}></span>
						<span class="mp-label">{p.label}</span>
					</button>
				</div>
			{/each}
		</div>
	{/each}
</div>

<style>
	.mp-root {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		margin: var(--space-1) 0 var(--space-2);
	}
	.mp-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: 0 var(--space-1);
	}
	.mp-title {
		font-size: var(--fs-section);
		font-weight: 600;
		letter-spacing: var(--tracking-section);
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.mp-actions {
		display: inline-flex;
		gap: var(--space-1);
	}
	.mp-picked {
		max-width: 50%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.mp-row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2) var(--space-1);
		padding: 0 2px;
	}
	.mp-mine {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
	}
	.mp-swatch {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		width: 48px;
		padding: var(--space-1) 0 2px;
		border-radius: var(--radius-button);
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-2);
		cursor: pointer;
	}
	.mp-swatch:hover {
		background: var(--surface-hover);
	}
	.mp-swatch:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}
	.mp-swatch[aria-pressed='true'] {
		border-color: var(--accent);
		background: var(--surface-active);
	}
	.mp-ball {
		display: block;
		width: 30px;
		height: 30px;
		border-radius: var(--radius-pill);
		box-shadow: 0 0 0 1px var(--border-strong);
		/* see-through looks (glass) show the panel's inset well behind them */
		background-color: var(--surface-inset);
	}
	.mp-label {
		max-width: 46px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--fs-badge);
		line-height: 1.2;
	}
	.mp-naming {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		padding: 0 var(--space-1);
	}
	/* the kit's field look (SearchField's inset well), for a plain text input */
	.mp-name-input {
		flex: 1;
		min-width: 0;
		box-sizing: border-box;
		height: var(--control-h-sm);
		padding: 0 var(--space-2);
		font: inherit;
		font-size: var(--fs-desc);
		border-radius: var(--radius-input);
		border: 1px solid var(--border-input);
		background: var(--surface-inset);
		color: var(--text);
		outline: none;
	}
	.mp-name-input:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
	}
	.mp-error {
		padding: 0 var(--space-2);
		font-size: var(--fs-desc);
		color: var(--ink-bad);
	}
	.mp-editbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		padding: 2px var(--space-1);
	}
	.mp-hint,
	.mp-peer {
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.mp-peer {
		margin-top: var(--space-1);
		padding: 0 var(--space-1);
	}
</style>
