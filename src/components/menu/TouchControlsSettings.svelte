<script module>
	/** 36 I4: what the settings search should also match for this section (labels are searched
	 * already; these are the words people type for it). */
	export const keywords = ['touch', 'mobile', 'phone', 'tablet', 'buttons', 'joystick', 'stick', 'jump', 'fire', 'haptic', 'vibrate', 'layout', 'on-screen'];
</script>

<script>
	// 36 U8: SETTINGS ▸ TOUCH CONTROLS — its own section file (the settings hot spot rule:
	// Settings.svelte gains one import and one line). Every value here is a LOCAL per-device pref
	// (touchActions: safeStorage), the gamepadPrefs family — never replicated, never saved into a scene.
	//
	// 37-settings (R21, docs/settings-inventory.md §3.4): on the redesign kit. "Button looks" is a
	// 3-column TILE grid (icon, name, Default / Custom); a tile opens that button's SUB-PAGE in the
	// content area ("Touch controls › Jump": released + pressed image, tint, size, the default look)
	// instead of ten controls crammed into one row. Same stores, same keys.
	import { getContext } from 'svelte';
	import { get } from 'svelte/store';
	import AccordionItem from './settings/SettingsSection.svelte';
	import Section from '../ui/Section.svelte';
	import SettingRow from '../ui/SettingRow.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Slider from '../ui/Slider.svelte';
	import Button from '../ui/Button.svelte';
	import TouchActionButton from '../play/TouchActionButton.svelte';
	import { settingsOpen, settingsSection, showToast } from '../../stores/appStore.js';
	import { NAV_CONTEXT } from '$lib/settingsNav';
	import { explorerItems, itemBlob } from '$lib/explorer';
	import { touchLookSpeed, setTouchLookSpeed, TOUCH_LOOK_SPEED_RANGE } from '$lib/touchControls';
	import {
		BUILTIN_ACTIONS,
		MAX_TEXTURE_BYTES,
		TEXTURE_SCALE_RANGE,
		touchPrefs,
		setTouchPrefs,
		touchTextures,
		setTouchTexture,
		clearTouchTexture,
		normalizeAction,
		resetTouchLayout,
		openTouchLayoutEditor
	} from '$lib/touchActions';
	import { touchSpec } from '$lib/touchSpec';
	import { gameId } from '$lib/gameSettings';

	/** while the settings search has a query, the section is open so its rows can match */
	let { searching = false } = $props();

	const nav = /** @type {any} */ (getContext(NAV_CONTEXT));
	const sub = nav?.sub;

	let open = $state(false);
	/** the expansion before a search opened the section, restored when it clears
	 * @type {boolean | null} */
	let beforeSearch = null;
	$effect(() => {
		if ($settingsOpen) open = $settingsSection === 'touch';
	});
	$effect(() => {
		const on = searching;
		if (on && beforeSearch === null) {
			beforeSearch = open;
			open = true;
		} else if (!on && beforeSearch !== null) {
			open = beforeSearch;
			beforeSearch = null;
		}
	});

	/** the built-in actions, then whatever the scene on screen adds (a module's own)
	 * @param {import('$lib/touchActions').TouchControlsSpec} spec
	 * @returns {import('$lib/touchActions').TouchAction[]} */
	function actionList(spec) {
		/** @type {import('$lib/touchActions').TouchAction[]} */
		const list = [];
		for (const id of Object.keys(BUILTIN_ACTIONS)) {
			const a = normalizeAction(id);
			if (a) list.push(a);
		}
		for (const a of spec.actions) if (!BUILTIN_ACTIONS[a.id]) list.push(a);
		return list;
	}
	const actions = $derived(actionList($touchSpec));
	/** the action whose sub-page is open ("touch:<id>") */
	const editing = $derived($sub?.id?.startsWith('touch:') ? (actions.find((a) => 'touch:' + a.id === $sub.id) ?? null) : null);
	const imageItems = $derived($explorerItems.filter((it) => it.kind === 'image' || /\.svg$/i.test(it.name ?? '')));

	const VISIBILITY = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'always', label: 'Always' },
		{ value: 'never', label: 'Never' }
	];

	function editLayout() {
		settingsOpen.set(false);
		openTouchLayoutEditor();
	}

	function resetLayouts() {
		resetTouchLayout('game', get(gameId));
		resetTouchLayout('global', get(gameId));
		showToast('Touch layout reset to the default arrangement');
	}

	/** @param {Blob} blob @returns {Promise<string | null>} */
	function blobToDataUrl(blob) {
		if (blob.size > MAX_TEXTURE_BYTES) {
			showToast('That image is too big for a button (max ' + Math.round(MAX_TEXTURE_BYTES / 1024) + ' KB)');
			return Promise.resolve(null);
		}
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
			reader.onerror = () => resolve(null);
			reader.readAsDataURL(blob);
		});
	}

	/** @param {string} state @returns {'released' | 'pressed'} */
	const asState = (state) => (state === 'pressed' ? 'pressed' : 'released');
	/** @param {import('$lib/touchActions').TouchTexture | null} tex @param {string} state */
	const texHas = (tex, state) => !!tex?.[asState(state)];

	/** @param {string} id @param {string} state @param {any} e */
	async function onUpload(id, state, e) {
		const input = e.currentTarget;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		if (!/^image\/(png|svg\+xml|jpeg|webp|gif)$/.test(file.type)) {
			showToast('Pick a PNG or SVG image');
			return;
		}
		const url = await blobToDataUrl(file);
		if (url) setTouchTexture(id, { [asState(state)]: url });
	}

	/** @param {string} id @param {string} state @param {any} e */
	async function onExplorerPick(id, state, e) {
		const select = e.currentTarget;
		const itemId = select.value;
		select.value = '';
		if (!itemId) return;
		const blob = await itemBlob(itemId);
		if (!blob) {
			showToast('That file is not on this device yet');
			return;
		}
		const typed = blob.type ? blob : new Blob([blob], { type: /\.svg$/i.test(imageItems.find((i) => i.id === itemId)?.name ?? '') ? 'image/svg+xml' : 'image/png' });
		const url = await blobToDataUrl(typed);
		if (url) setTouchTexture(id, { [asState(state)]: url });
	}

	/** @type {Record<string, HTMLInputElement>} */
	const fileInputs = {};
	/** @param {string} id */
	const safeId = (id) => id.replace(/[^\w-]/g, '_');
</script>

<AccordionItem bind:open>
	{#snippet header()}<span id="settings-touch-header" data-tour="settings-touch">Touch controls</span>{/snippet}
	<div class="settings-page-body" data-keywords={keywords.join(' ')}>
		{#if editing}
			{@const tex = $touchTextures[editing.id] ?? null}
			<Section variant="card" label="Preview">
				<div class="tcs-previews" data-touch-texture={editing.id}>
					<span class="tcs-preview"><TouchActionButton action={editing} size={56} texture={tex} /><span class="tcs-cap">Released</span></span>
					<span class="tcs-preview"><TouchActionButton action={editing} size={56} texture={tex} pressed={true} /><span class="tcs-cap">Pressed</span></span>
				</div>
			</Section>
			<Section variant="card" label="Images">
				{#each [['released', 'Released image'], ['pressed', 'Pressed image']] as [state, label] (state)}
					<SettingRow id={'row-touch-' + state} {label} description="A PNG or SVG, up to 160 KB." wide>
						<Button size="sm" variant="outline" id={'touch-tex-upload-' + state + '-' + safeId(editing.id)} onclick={() => fileInputs[editing.id + state]?.click()}>Upload…</Button>
						<input
							type="file"
							accept="image/png,image/svg+xml,.png,.svg"
							style="display: none"
							bind:this={fileInputs[editing.id + state]}
							data-touch-tex-file={editing.id + ':' + state}
							onchange={(e) => onUpload(editing.id, state, e)}
						/>
						<select class="tcs-select" aria-label={'Pick a ' + label.toLowerCase() + ' from Explorer'} onchange={(e) => onExplorerPick(editing.id, state, e)}>
							<option value="">From Explorer…</option>
							{#each imageItems as item (item.id)}
								<option value={item.id}>{item.name}</option>
							{/each}
						</select>
						{#if texHas(tex, state)}
							<Button size="sm" variant="ghost" label={'Clear the ' + label.toLowerCase()} onclick={() => setTouchTexture(editing.id, { [asState(state)]: undefined })}>Clear</Button>
						{/if}
					</SettingRow>
				{/each}
			</Section>
			<Section variant="card" label="Look">
				<SettingRow id="row-touch-tint" label="Tint" description="Colours the button’s icon or image.">
					<input
						type="color"
						class="tcs-color"
						value={tex?.tint ?? '#ffffff' /* tokens-ok: the tint picker's starting value (user data) */}
						onchange={(e) => setTouchTexture(editing.id, { tint: e.currentTarget.value })}
						aria-label={'Tint for ' + editing.label}
					/>
				</SettingRow>
				<SettingRow id="row-touch-size" label="Size" description="The icon’s size inside the button.">
					<Slider
						id="touch-tex-size"
						label={'Icon size for ' + editing.label}
						min={TEXTURE_SCALE_RANGE.min}
						max={TEXTURE_SCALE_RANGE.max}
						step={0.05}
						value={tex?.scale ?? 1}
						format={(v) => v.toFixed(2) + '×'}
						onchange={(v) => setTouchTexture(editing.id, { scale: v })}
					/>
				</SettingRow>
				{#if tex}
					<SettingRow id="row-touch-default" label="Use the default look" description="Drops the images, tint and size of this button.">
						<Button size="sm" variant="outline" onclick={() => clearTouchTexture(editing.id)}>Default look</Button>
					</SettingRow>
				{/if}
			</Section>
		{:else}
			<Section variant="card" label="On-screen controls" badge="This device">
				<SettingRow id="row-touch-visibility" label="Show touch controls" description="Auto shows them in Play on a touch screen.">
					<Segmented id="touch-visibility" label="Show touch controls" options={VISIBILITY} value={$touchPrefs.visibility} onchange={(v) => setTouchPrefs({ visibility: /** @type {any} */ (v) })} />
				</SettingRow>
				<SettingRow id="row-touch-in-edit" label="Show in edit" description="Also draw the action buttons while editing.">
					<Toggle id="touch-show-in-edit" label="Show in edit" checked={$touchPrefs.showInEdit} onchange={(on) => setTouchPrefs({ showInEdit: on })} />
				</SettingRow>
				<SettingRow id="row-touch-haptics" label="Haptic tick" description="A short vibration on each press, where supported." keywords="vibrate vibration haptics">
					<Toggle id="touch-haptics" label="Haptic tick" checked={$touchPrefs.haptics} onchange={(on) => setTouchPrefs({ haptics: on })} />
				</SettingRow>
				<SettingRow id="row-touch-look" label="Look speed" description="How far a drag on the right half turns the view.">
					<Slider
						id="touch-look-speed"
						label="Touch look speed"
						min={TOUCH_LOOK_SPEED_RANGE.min}
						max={TOUCH_LOOK_SPEED_RANGE.max}
						step={0.05}
						value={$touchLookSpeed}
						format={(v) => v.toFixed(2) + '×'}
						onchange={(v) => setTouchLookSpeed(v)}
					/>
				</SettingRow>
				<SettingRow id="row-touch-layout" label="Layout" description="Move, resize and fade the stick and buttons, per game or for all." wide>
					<Button id="touch-reset-layout" size="sm" variant="outline" onclick={resetLayouts}>Reset</Button>
					<Button id="touch-edit-layout" data-tour="touch-edit-layout" size="sm" variant="outline" onclick={editLayout}>Edit layout</Button>
				</SettingRow>
			</Section>
			<Section variant="card" label="Button looks">
				<SettingRow id="row-touch-looks" label="Button looks" description="Pick one to change its images, tint and size." keywords="images icons textures look">
					{#snippet extra()}
						<div class="tcs-grid">
							{#each actions as action (action.id)}
								{@const tex = $touchTextures[action.id] ?? null}
								<button
									type="button"
									class="tcs-tile"
									data-touch-tile={action.id}
									onclick={() => nav.openSub('touch:' + action.id, action.label, 'touchcontrols')}
								>
									<TouchActionButton {action} size={40} texture={tex} />
									<span class="tcs-tile-name">{action.label}</span>
									<span class="tcs-tile-state" class:tcs-custom={!!tex}>{tex ? 'Custom' : 'Default'}</span>
								</button>
							{/each}
						</div>
					{/snippet}
				</SettingRow>
			</Section>
		{/if}
	</div>
</AccordionItem>

<style>
	.settings-page-body {
		display: contents;
	}
	.tcs-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
	}
	.tcs-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		min-height: 44px;
		padding: 12px 6px 10px;
		border: 1px solid var(--border);
		border-radius: var(--radius-card, 10px);
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		cursor: pointer;
	}
	.tcs-tile:hover {
		border-color: var(--border-strong);
		background: var(--surface-hover);
	}
	.tcs-tile-name {
		font-size: var(--fs-body);
		font-weight: 500;
	}
	.tcs-tile-state {
		font-size: var(--fs-badge, 11px);
		color: var(--text-faint);
	}
	.tcs-custom {
		color: var(--accent-text);
	}
	.tcs-previews {
		display: flex;
		gap: 28px;
		padding: 16px 18px;
	}
	.tcs-preview {
		display: inline-flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}
	.tcs-cap {
		font-size: var(--fs-desc);
		color: var(--text-muted);
	}
	.tcs-select {
		max-width: 160px;
		height: var(--control-h-sm);
		padding: 0 8px;
		border: 1px solid var(--border-input);
		border-radius: var(--radius-button, 8px);
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-desc);
	}
	.tcs-color {
		width: 40px;
		height: 28px;
		padding: 0;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		background: transparent;
		cursor: pointer;
	}
	@media (max-width: 639.98px) {
		.tcs-select {
			font-size: 16px;
			height: 44px;
		}
	}
</style>
