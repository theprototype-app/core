<script context="module">
	/** 36 I4: what the settings search should also match for this section (labels are
	 * searched already; these are the words people type for it). */
	export const keywords = ['touch', 'mobile', 'phone', 'tablet', 'buttons', 'joystick', 'stick', 'jump', 'fire', 'haptic', 'vibrate', 'layout', 'on-screen'];
</script>

<script>
	// 36 U8: SETTINGS ▸ TOUCH CONTROLS — its own section file (the settings hot spot rule:
	// Settings.svelte gains one import and one line). Legacy mode on purpose, like every
	// row it sits beside: SettingRow takes `slot="control"`.
	//
	// Every value here is a LOCAL per-device pref (touchActions: safeStorage), the
	// gamepadPrefs family — never replicated, never saved into a scene.
	import { Toggle } from 'flowbite-svelte';
	// 36 B14: a section of its own, so it registers with the Settings sidebar like the rest
	import AccordionItem from './settings/SettingsSection.svelte';
	import { get } from 'svelte/store';
	import SettingRow from './SettingRow.svelte';
	import TouchActionButton from '../play/TouchActionButton.svelte';
	import { settingsOpen, settingsSection, showToast } from '../../stores/appStore.js';
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
	export let searching = false;

	let open = false;
	/** the expansion before a search opened the section, restored when it clears
	 * @type {boolean | null} */
	let beforeSearch = null;
	$: if ($settingsOpen) open = $settingsSection === 'touch';
	$: syncSearch(searching);
	/** @param {boolean} on */
	function syncSearch(on) {
		if (on && beforeSearch === null) {
			beforeSearch = open;
			open = true;
		} else if (!on && beforeSearch !== null) {
			open = beforeSearch;
			beforeSearch = null;
		}
	}

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
	$: actions = actionList($touchSpec);

	$: imageItems = $explorerItems.filter((it) => it.kind === 'image' || /\.svg$/i.test(it.name ?? ''));

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
</script>

<AccordionItem bind:open>
	{#snippet header()}<span id="settings-touch-header" data-tour="settings-touch">Touch controls</span>{/snippet}
	<p class="ui-section-label">On-screen controls</p>
	<SettingRow name="Show touch controls">
		<svelte:fragment slot="control">
			<span class="tp-seg" role="group" aria-label="Show touch controls">
				{#each [['auto', 'Auto'], ['always', 'Always'], ['never', 'Never']] as [value, label] (value)}
					<button
						type="button"
						id={'touch-visibility-' + value}
						class="tp-seg-btn"
						aria-pressed={$touchPrefs.visibility === value}
						on:click={() => setTouchPrefs({ visibility: /** @type {any} */ (value) })}>{label}</button
					>
				{/each}
			</span>
		</svelte:fragment>
		<span>Auto shows the stick and action buttons in Play on a touch screen (or once you touch the screen). Always forces them on, Never hides them<span class="sr-only"> — {keywords.join(', ')}</span></span>
	</SettingRow>
	<SettingRow name="Show in edit">
		<svelte:fragment slot="control">
			<Toggle id="touch-show-in-edit" checked={$touchPrefs.showInEdit} onchange={(e) => setTouchPrefs({ showInEdit: e.currentTarget.checked })} />
		</svelte:fragment>
		<span>Also draw the action buttons while editing (they press keys there too). The stick and look only exist in Play</span>
	</SettingRow>
	<SettingRow name="Haptic tick">
		<svelte:fragment slot="control">
			<Toggle id="touch-haptics" checked={$touchPrefs.haptics} onchange={(e) => setTouchPrefs({ haptics: e.currentTarget.checked })} />
		</svelte:fragment>
		<span>A short vibration when a button is pressed (phones that support it)</span>
	</SettingRow>
	<SettingRow name="Look speed">
		<svelte:fragment slot="control">
			<input
				id="touch-look-speed"
				type="range"
				style="width: 100%"
				min={TOUCH_LOOK_SPEED_RANGE.min}
				max={TOUCH_LOOK_SPEED_RANGE.max}
				step="0.05"
				value={$touchLookSpeed}
				on:input={(e) => setTouchLookSpeed(Number(e.currentTarget.value))}
				aria-label="Touch look speed"
			/>
		</svelte:fragment>
		<span>How far a drag on the right half turns the view ({$touchLookSpeed.toFixed(2)}×)</span>
	</SettingRow>
	<SettingRow name="Layout">
		<svelte:fragment slot="control">
			<span class="sr-stack">
				<button id="touch-edit-layout" data-tour="touch-edit-layout" class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500" on:click={editLayout}>Edit layout</button>
				<button id="touch-reset-layout" class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500" on:click={resetLayouts}>Reset</button>
			</span>
		</svelte:fragment>
		<span>Drag, resize and fade the stick and every button — for this game or all games, saved on this device. Also in the pause menu during a game</span>
	</SettingRow>
	<p class="ui-section-label">Button looks</p>
	{#each actions as action (action.id)}
		{@const tex = $touchTextures[action.id] ?? null}
		<SettingRow name={action.label} noControl={true}>
			<div class="tcs-row" data-touch-texture={action.id}>
				<span class="tcs-preview" title="Released">
					<TouchActionButton {action} size={44} texture={tex} />
				</span>
				<span class="tcs-preview" title="Pressed">
					<TouchActionButton {action} size={44} texture={tex} pressed={true} />
				</span>
				{#each [['released', 'Released'], ['pressed', 'Pressed']] as [state, label] (state)}
					<span class="tcs-state">
						<span class="tcs-label">{label}</span>
						<button
							type="button"
							class="tcs-btn"
							id={'touch-tex-upload-' + state + '-' + action.id.replace(/[^\w-]/g, '_')}
							on:click={() => fileInputs[action.id + state]?.click()}>Upload</button
						>
						<input
							type="file"
							accept="image/png,image/svg+xml,.png,.svg"
							style="display: none"
							bind:this={fileInputs[action.id + state]}
							data-touch-tex-file={action.id + ':' + state}
							on:change={(e) => onUpload(action.id, state, e)}
						/>
						<select class="tcs-select" aria-label={'Pick a ' + label.toLowerCase() + ' image from Explorer'} on:change={(e) => onExplorerPick(action.id, state, e)}>
							<option value="">Explorer…</option>
							{#each imageItems as item (item.id)}
								<option value={item.id}>{item.name}</option>
							{/each}
						</select>
						{#if texHas(tex, state)}
							<button type="button" class="tcs-btn" aria-label={'Clear the ' + label.toLowerCase() + ' image'} on:click={() => setTouchTexture(action.id, { [asState(state)]: undefined })}>✕</button>
						{/if}
					</span>
				{/each}
				<label class="tcs-state">
					<span class="tcs-label">Tint</span>
					<input
						type="color"
						class="tcs-color"
						value={tex?.tint ?? '#ffffff'}
						on:change={(e) => setTouchTexture(action.id, { tint: e.currentTarget.value })}
						aria-label={'Tint for ' + action.label}
					/>
				</label>
				<label class="tcs-state">
					<span class="tcs-label">Size</span>
					<input
						type="range"
						class="tcs-range"
						min={TEXTURE_SCALE_RANGE.min}
						max={TEXTURE_SCALE_RANGE.max}
						step="0.05"
						value={tex?.scale ?? 1}
						on:input={(e) => setTouchTexture(action.id, { scale: Number(e.currentTarget.value) })}
						aria-label={'Icon size for ' + action.label}
					/>
				</label>
				{#if tex}
					<button type="button" class="tcs-btn" on:click={() => clearTouchTexture(action.id)}>Default look</button>
				{/if}
			</div>
		</SettingRow>
	{/each}
</AccordionItem>

<style>
	.tcs-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px 10px;
	}
	.tcs-preview {
		display: inline-flex;
		padding: 2px;
		border-radius: 9999px;
		background: rgb(var(--surface-deep-rgb, 0 0 0) / 0.5);
	}
	.tcs-state {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}
	.tcs-label {
		font-size: 11px;
		color: var(--muted, #9ca3af);
	}
	.tcs-btn {
		padding: 1px 6px;
		font-size: 11px;
		border-radius: 4px;
		border: 1px solid var(--border, #4b5563);
		background: var(--surface-2, #374151);
		color: var(--text, #f3f4f6);
	}
	.tcs-select {
		max-width: 110px;
		padding: 1px 4px;
		font-size: 11px;
		border-radius: 4px;
		border: 1px solid var(--border, #4b5563);
		background: var(--field, #111827);
		color: var(--text, #f3f4f6);
	}
	.tcs-color {
		width: 28px;
		height: 20px;
		padding: 0;
		border: 1px solid var(--border, #4b5563);
		border-radius: 4px;
		background: transparent;
	}
	.tcs-range {
		width: 70px;
	}
</style>
