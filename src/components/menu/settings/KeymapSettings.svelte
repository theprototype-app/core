<script>
	// 103 H5 / H10 — Settings ▸ Shortcuts ▸ Keymap: the preset (a set of default bindings; your own
	// rebinds win) and the two fly prefs the presets lean on. Loaded lazily by ShortcutsSettings, so
	// the preset tables never reach the boot.
	//
	// 103 row 9 (owner, 22 Nov): YOUR OWN KEYMAPS beside the built-in presets — Save current as…, switch, rename,
	// duplicate, delete, export / import a small JSON file ($lib/keymaps, lazy with this card). A changed keymap shows a
	// dot and "Save changes / Discard"; switching away from one that would lose its changes asks first. Stored on this
	// device with the other settings (settings do not sync between devices today).
	// 103 row 10: reset at three levels, each with a confirm that says what changes — one shortcut (the row's ↺ in the
	// grid), THIS keymap back to its base preset (here), and everything back to ThePrototype defaults (here and the
	// page footer's "Reset Shortcuts to defaults").
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Button from '../../ui/Button.svelte';
	import { keymapPreset, activeKeymapId } from '$lib/shortcuts';
	import { KEYMAP_PRESETS } from '$lib/keymapPresets';
	import { flyWithWasd, flyDirection } from '$lib/flyPrefs';
	import {
		savedKeymaps,
		activeKeymap,
		keymapDirty,
		saveCurrentAs,
		saveChanges,
		discardChanges,
		switchDropsChanges,
		switchKeymap,
		renameKeymap,
		duplicateKeymap,
		deleteKeymap,
		exportKeymap,
		importKeymap,
		uniqueName,
		changedFromBaseCount,
		resetKeymapToBase
	} from '$lib/keymaps';
	import { showChoice, showConfirm } from '$lib/confirmDialog';
	import { askResetCategory } from '$lib/settings/resetCategory.js';
	import { showToast } from '../../../stores/appStore.js';

	/** @type {{ onchange?: () => void }} */
	let { onchange = () => {} } = $props();

	/** redraw signal: the working state lives in plain module variables, so a change bumps this */
	let tickN = $state(0);
	const bump = () => {
		tickN++;
		onchange();
	};

	const presetLabel = (/** @type {string} */ id) => KEYMAP_PRESETS.find((p) => p.id === id)?.label ?? id;
	const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;
	const go = (/** @type {number} */ n) => (n === 1 ? 'goes' : 'go');

	const current = $derived((void tickN, void $savedKeymaps, void $activeKeymapId, void $keymapPreset, activeKeymap()));
	const dirty = $derived((void tickN, void $savedKeymaps, void $activeKeymapId, void $keymapPreset, keymapDirty()));
	const selected = $derived(current ? current.id : 'preset:' + $keymapPreset);
	const currentName = $derived(current ? current.name : presetLabel($keymapPreset));
	const changedCount = $derived((void tickN, void $activeKeymapId, void $keymapPreset, changedFromBaseCount()));

	/** the inline name field (Save current as… / Rename) @type {{ mode: 'save' | 'rename', value: string } | null} */
	let naming = $state(null);
	/** @type {HTMLInputElement | null} */
	let nameInput = $state(null);
	$effect(() => {
		if (naming) nameInput?.focus();
	});
	/** @type {HTMLInputElement | null} */
	let fileInput = $state(null);

	/** @param {HTMLSelectElement} el */
	async function pick(el) {
		const target = el.value;
		if (target === selected) return;
		if (switchDropsChanges(target)) {
			const n = changedCount;
			const choice = await showChoice({
				title: `Save changes to ${currentName}?`,
				message: current
					? `You changed ${plural(n, 'shortcut')} in ${currentName} since you saved it. Switching keymaps puts the other keymap's keys in force.`
					: `${plural(n, 'shortcut')} you changed on ${currentName} would be replaced by the other keymap's keys. Save them as a keymap of your own first?`,
				choices: [
					{ value: 'save', label: current ? 'Save changes' : 'Save as a new keymap' },
					{ value: 'discard', label: 'Discard changes' }
				],
				cancelLabel: 'Cancel'
			});
			if (!choice) {
				el.value = selected; // the select snaps back
				return;
			}
			if (choice === 'save') {
				if (current) saveChanges();
				else saveCurrentAs(uniqueName(currentName.replace(/\s*\(default\)$/, '') + ' (my changes)'));
			}
		}
		await switchKeymap(target);
		bump();
	}

	function startSaveAs() {
		naming = { mode: 'save', value: uniqueName(current ? current.name + ' copy' : 'My keymap') };
	}
	function startRename() {
		if (current) naming = { mode: 'rename', value: current.name };
	}
	function commitName() {
		const n = naming;
		if (!n || !n.value.trim()) return;
		naming = null;
		if (n.mode === 'save') {
			const k = saveCurrentAs(n.value);
			if (k) showToast(`Saved keymap ${k.name}`);
			else showToast('You have as many keymaps as this device keeps; delete one first');
		} else if (current) renameKeymap(current.id, n.value);
		bump();
	}
	/** @param {KeyboardEvent} e */
	function nameKey(e) {
		if (e.key === 'Enter') {
			e.preventDefault();
			commitName();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			naming = null;
		}
	}

	async function onSaveChanges() {
		if (current) {
			saveChanges();
			showToast(`Saved changes to ${current.name}`);
			bump();
		} else startSaveAs();
	}
	async function onDiscard() {
		const ok = await showConfirm({
			title: `Discard changes to ${currentName}?`,
			message: current
				? `${plural(changedCount, 'shortcut')} ${go(changedCount)} back to what ${currentName} has saved.`
				: `${plural(changedCount, 'shortcut')} ${go(changedCount)} back to the ${currentName} keys.`,
			confirmLabel: 'Discard',
			cancelLabel: 'Cancel'
		});
		if (!ok) return;
		await discardChanges();
		bump();
	}
	function onDuplicate() {
		if (!current) return;
		const copy = duplicateKeymap(current.id);
		if (copy) showToast(`Made ${copy.name}`);
		bump();
	}
	async function onDelete() {
		if (!current) return;
		const ok = await showConfirm({
			title: `Delete keymap ${current.name}?`,
			message: `The saved keymap goes. The keys you have now stay in force on ${presetLabel(current.base)}, shown as changed there.`,
			confirmLabel: 'Delete',
			cancelLabel: 'Cancel'
		});
		if (!ok) return;
		deleteKeymap(current.id);
		bump();
	}
	function onExport() {
		const file = exportKeymap(current, current ? undefined : currentName.replace(/\s*\(default\)$/, ''));
		showToast(`Exported ${file.name} (${plural(Object.keys(file.changes).length, 'change')} on ${presetLabel(file.base)})`);
	}
	/** @param {Event} e */
	async function onImportFile(e) {
		const el = /** @type {HTMLInputElement} */ (e.currentTarget);
		const file = el.files?.[0];
		el.value = '';
		if (!file) return;
		const text = file.size > 64 * 1024 ? '' : await file.text().catch(() => '');
		const r = file.size > 64 * 1024 ? { ok: false, reason: 'The file is too big for a keymap' } : importKeymap(text);
		if (!r.ok) return showToast(`Could not import the keymap: ${/** @type {any} */ (r).reason}`);
		const ok = /** @type {any} */ (r);
		showToast(`Imported keymap ${ok.keymap.name}` + (ok.unknown ? ` (${plural(ok.unknown, 'shortcut')} this version does not have)` : '') + ' — pick it under Keymap to use it');
		bump();
	}

	async function onResetKeymap() {
		const n = changedCount;
		const base = presetLabel(current ? current.base : $keymapPreset);
		const ok = await showConfirm({
			title: `Reset ${currentName} to ${base}?`,
			message: n
				? `${plural(n, 'shortcut')} ${go(n)} back to the ${base} keys${current ? `, and ${currentName} is saved that way` : ''}. Other keymaps are not touched.`
				: `Nothing is changed from ${base}.`,
			confirmLabel: n ? 'Reset' : 'OK',
			cancelLabel: 'Cancel'
		});
		if (!ok || !n) return;
		resetKeymapToBase();
		showToast(`${currentName}: ${plural(n, 'shortcut')} back to ${base}`);
		bump();
	}
	async function onResetAll() {
		if (await askResetCategory('shortcuts', 'Shortcuts')) bump();
	}
</script>

<!-- 103 H5: the keymap preset (a set of default bindings; your own rebinds win) and the two fly
     prefs the presets lean on; 103 rows 9 + 10: your own keymaps and the resets -->
<Section variant="card" label="Keymap">
	<SettingRow
		label="Keymap"
		description={current ? `Your keymap, based on ${presetLabel(current.base)}. New shortcuts in later versions arrive with their defaults.` : (KEYMAP_PRESETS.find((p) => p.id === $keymapPreset)?.hint ?? '')}
		data-keywords="keymap preset blender unity maya saved my keys export import"
	>
		<span class="km-pick">
			{#if dirty}<span id="keymap-dirty" class="km-dot" title="Changed since it was saved" aria-label="Changed since it was saved"></span>{/if}
			<select id="keymap-preset" class="settings-text" value={selected} onchange={(e) => pick(/** @type {HTMLSelectElement} */ (e.currentTarget))}>
				<optgroup label="Built in">
					{#each KEYMAP_PRESETS as preset (preset.id)}
						<option value={'preset:' + preset.id}>{preset.label}</option>
					{/each}
				</optgroup>
				{#if $savedKeymaps.length}
					<optgroup label="Your keymaps">
						{#each $savedKeymaps as k (k.id)}
							<option value={k.id}>{k.name}</option>
						{/each}
					</optgroup>
				{/if}
			</select>
		</span>
		{#snippet extra()}
			{#if dirty}
				<div id="keymap-changed" class="km-line" role="status">
					<span class="km-note">{plural(changedCount, 'shortcut')} changed{current ? ' since you saved it' : ` on ${currentName}`}</span>
					<Button size="sm" variant="primary" id="keymap-save-changes" onclick={onSaveChanges}>{current ? 'Save changes' : 'Save as…'}</Button>
					<Button size="sm" variant="ghost" id="keymap-discard" onclick={onDiscard}>Discard</Button>
				</div>
			{/if}
			{#if naming}
				<div class="km-line">
					<label class="km-note" for="keymap-name">{naming.mode === 'save' ? 'Name' : 'New name'}</label>
					<input id="keymap-name" class="settings-text km-name" maxlength="60" bind:this={nameInput} bind:value={naming.value} onkeydown={nameKey} />
					<Button size="sm" variant="primary" id="keymap-name-ok" disabled={!naming.value.trim()} onclick={commitName}>{naming.mode === 'save' ? 'Save' : 'Rename'}</Button>
					<Button size="sm" variant="ghost" onclick={() => (naming = null)}>Cancel</Button>
				</div>
			{/if}
			<div class="km-line km-actions">
				<Button size="sm" icon="save" id="keymap-save-as" onclick={startSaveAs}>Save current as…</Button>
				{#if current}
					<Button size="sm" variant="ghost" icon="pencil" id="keymap-rename" onclick={startRename}>Rename</Button>
					<Button size="sm" variant="ghost" icon="copy" id="keymap-duplicate" onclick={onDuplicate}>Duplicate</Button>
					<Button size="sm" variant="ghost" icon="trash-2" id="keymap-delete" onclick={onDelete}>Delete</Button>
				{/if}
				<Button size="sm" variant="ghost" icon="download" id="keymap-export" title="Download this keymap as a small JSON file" onclick={onExport}>Export</Button>
				<Button size="sm" variant="ghost" icon="upload" id="keymap-import" title="Add a keymap from a JSON file" onclick={() => fileInput?.click()}>Import</Button>
				<input bind:this={fileInput} id="keymap-import-file" type="file" accept=".json,application/json" hidden onchange={onImportFile} />
			</div>
		{/snippet}
	</SettingRow>
	<SettingRow label="Reset" description="One shortcut: the reset arrow beside it below. This keymap: every shortcut back to its base preset. Everything: no changes, the ThePrototype keymap.">
		<span class="km-pick">
			<Button size="sm" variant="ghost" id="keymap-reset-keymap" onclick={onResetKeymap}>Reset this keymap</Button>
			<Button size="sm" variant="warn-text" id="keymap-reset-all" onclick={onResetAll}>Reset everything</Button>
		</span>
	</SettingRow>
	<SettingRow label="Fly with WASD" description="Only while holding the right mouse button frees W A S D Q E for commands (Blender's bare S, Unity's W / E / R).">
		<select
			id="fly-with-wasd"
			class="settings-text"
			value={$flyWithWasd}
			onchange={(e) => {
				flyWithWasd.set(/** @type {HTMLSelectElement} */ (e.currentTarget).value);
				onchange();
			}}
		>
			<option value="always">Always</option>
			<option value="rmb">Only while holding the right mouse button</option>
		</select>
	</SettingRow>
	<SettingRow label="Fly direction" description="Where I look: W / S follow the view, so looking up and pressing W climbs. Q / E always move straight down / up.">
		<select id="fly-direction" class="settings-text" bind:value={$flyDirection}>
			<option value="level">Level</option>
			<option value="look">Where I look</option>
		</select>
	</SettingRow>
</Section>

<style>
	.km-pick {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
		justify-content: flex-end;
	}
	.km-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		flex: 0 0 auto;
	}
	.km-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 8px;
	}
	.km-actions {
		margin-top: 10px;
	}
	.km-note {
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.km-name {
		flex: 1 1 160px;
		min-width: 0;
	}
</style>
