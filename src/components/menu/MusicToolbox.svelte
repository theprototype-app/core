<script>
	// 23-B2 — the Music toolbox body: device settings from the spec's params, presets,
	// and a mixer strip. Mounted by musicToolbox.js into the shared toolbox shell.
	//
	// Every write goes through the A3/A4 paths — setDeviceFor / setDeviceParam /
	// setCableGain — so it replicates and undoes like any other edit. A DragRow SCRUB is
	// one gesture: previews through previewDeviceParams (history-free, replicated at
	// ~15 Hz) and ONE exact setDeviceFor on release carrying the document the scrub
	// STARTED from as `before`, the VR knob's shape exactly.
	import { onMount } from 'svelte';
	import DragRow from '../ui/DragRow.svelte';
	import { selectedObject, objectsGroup } from '../../stores/sceneStore';
	import {
		listDeviceObjects,
		deviceOf,
		deviceSpec,
		findDeviceObject,
		setDeviceFor,
		setDeviceParam,
		previewDeviceParams,
		deviceCatalogVersion,
		deviceLevel
	} from '$lib/audioDevices';
	import { patch, cablesOf, setCableGain } from '$lib/audioPatch';
	import { beginHistoryBatch, endHistoryBatch } from '$lib/history';
	import { musicPresets, presetsFor, savePreset, deletePreset, applyPreset } from '$lib/musicToolbox';
	import { musicToolboxPick } from '$lib/musicToolbox';

	/** bumps after a local write so derived reads re-run even when no store poked */
	let tick = $state(0);
	/** an explicit pick in the device picker; the selection otherwise */
	let pickedUuid = $state('');
	// 23-B4: an external pick (the Inspector's link) becomes the explicit pick, once
	$effect(() => {
		const uuid = $musicToolboxPick;
		if (uuid) {
			pickedUuid = uuid;
			musicToolboxPick.set('');
		}
	});

	/** every device object in the scene, with its document and spec */
	const devices = $derived.by(() => {
		void tick;
		void $objectsGroup;
		void $deviceCatalogVersion;
		return listDeviceObjects().map((object) => ({
			uuid: object.uuid,
			name: object.name || object.userData.device.kind,
			doc: deviceOf(object) ?? { kind: String(object.userData.device.kind), params: {} },
			spec: deviceSpec(object.userData.device.kind)
		}));
	});

	/** the device the settings face shows: the picked one, else the selected one, else the first */
	const current = $derived.by(() => {
		const selected = /** @type {any} */ ($selectedObject)?.uuid;
		const uuid = pickedUuid && devices.some((d) => d.uuid === pickedUuid) ? pickedUuid : selected;
		return devices.find((d) => d.uuid === uuid) ?? devices[0] ?? null;
	});

	/** the declared params of the current device (an unknown kind has none) */
	const params = $derived(current?.spec?.params ?? []);

	// ---- editing --------------------------------------------------------------------------

	/** the open scrub gesture: which device, the document it started from, the last write */
	/** @type {{uuid: string, before: any, lastSent: number, last: {key: string, value: any}|null}|null} */
	let gesture = null;
	const SEND_MS = 66;

	/** @param {string} uuid */
	function scrubStart(uuid) {
		const object = findDeviceObject(uuid);
		if (!object) return;
		gesture = { uuid, before: structuredClone(object.userData.device), lastSent: 0, last: null };
	}

	/**
	 * A range value onto the param's grid. DragRow's keyboard steps by its own minor unit
	 * (1 at 0 decimals), so a nudge smaller than the spec's step becomes ONE step in that
	 * direction — an ArrowUp on a 10 Hz grid moves 10 Hz, not 1 and then back to 0.
	 * @param {any} p @param {number} current @param {number} value
	 */
	function onGrid(p, current, value) {
		const step = typeof p?.step === 'number' && p.step > 0 ? p.step : 0;
		if (!step) return value;
		let v = value;
		if (v !== current && Math.abs(v - current) < step) v = current + Math.sign(v - current) * step;
		const min = typeof p.min === 'number' ? p.min : 0;
		v = min + Math.round((v - min) / step) * step;
		if (typeof p.min === 'number') v = Math.max(p.min, v);
		if (typeof p.max === 'number') v = Math.min(p.max, v);
		return +v.toFixed(6);
	}

	/** @param {string} uuid @param {string} key @param {any} value */
	function change(uuid, key, value) {
		const p = params.find((x) => x.key === key);
		if (p && (p.kind === 'range' || p.kind === undefined) && typeof value === 'number') {
			const currentValue = Number(current?.doc.params[key] ?? p.default ?? 0);
			value = onGrid(p, currentValue, value);
			if (value === currentValue && !(gesture && gesture.uuid === uuid)) return;
		}
		if (gesture && gesture.uuid === uuid) {
			const now = Date.now();
			const broadcast = now - gesture.lastSent >= SEND_MS;
			if (broadcast) gesture.lastSent = now;
			previewDeviceParams(uuid, { [key]: value }, { broadcast });
			gesture.last = { key, value };
		} else {
			setDeviceParam(uuid, key, value);
		}
		tick++;
	}

	/** @param {string} uuid */
	function scrubEnd(uuid) {
		if (!gesture || gesture.uuid !== uuid) return;
		const open = gesture;
		gesture = null;
		if (open.last) setDeviceFor(uuid, { params: { [open.last.key]: open.last.value } }, { before: open.before });
		tick++;
	}

	// ---- presets ---------------------------------------------------------------------------

	let presetName = $state('');
	let presetPick = $state('');
	const presets = $derived.by(() => {
		void $musicPresets;
		return current ? presetsFor(current.doc.kind) : [];
	});

	function saveCurrentPreset() {
		if (!current) return;
		if (savePreset(current.doc.kind, presetName, current.doc.params)) {
			presetPick = presetName.trim();
			presetName = '';
		}
	}

	function applyPickedPreset() {
		if (!current) return;
		const preset = presets.find((p) => p.name === presetPick);
		if (preset) applyPreset(current.uuid, preset);
		tick++;
	}

	function deletePickedPreset() {
		if (!current || !presetPick) return;
		deletePreset(current.doc.kind, presetPick);
		presetPick = '';
	}

	// ---- the mixer ------------------------------------------------------------------------

	/** live output level per device, 0..1, sampled at 10 Hz */
	let levels = $state(/** @type {Record<string, number>} */ ({}));
	onMount(() => {
		const timer = setInterval(() => {
			/** @type {Record<string, number>} */
			const next = {};
			for (const d of devices) next[d.uuid] = deviceLevel(d.uuid);
			levels = next;
		}, 100);
		return () => clearInterval(timer);
	});

	/** what a channel's fader writes: the device's own level/gain param when it declares
	 * one, else the gain of its outgoing cables (a speaker has the first, an instrument
	 * without a level knob the second) */
	/** @param {any} d @returns {{kind: 'param', key: string, cables: null, value: number, max: number} | {kind: 'cables', key: null, cables: any[], value: number, max: number} | null} */
	function faderOf(d) {
		void $patch;
		const key = d.spec?.params?.find((/** @type {any} */ p) => p.key === 'level' || p.key === 'gain')?.key;
		if (key) return { kind: 'param', key, cables: null, value: Number(d.doc.params[key] ?? 0), max: 1 };
		const cables = cablesOf(d.uuid).filter((c) => c.from.uuid === d.uuid);
		if (!cables.length) return null;
		return { kind: 'cables', key: null, cables, value: cables[0].gain, max: 2 };
	}

	/** @param {any} d @param {number} value */
	function setFader(d, value) {
		const fader = faderOf(d);
		if (!fader) return;
		if (fader.key) change(d.uuid, fader.key, value);
		else {
			const cables = fader.cables ?? [];
			if (cables.length > 1) beginHistoryBatch();
			for (const c of cables) setCableGain(c.id, value);
			if (cables.length > 1) endHistoryBatch('Channel level');
		}
		tick++;
	}

	/** what each channel held before it was muted, so unmute restores it (LOCAL: the
	 * mute itself is the replicated write, this is only this user's memory of the level) */
	let mutedAt = $state(/** @type {Record<string, number>} */ ({}));
	let soloed = $state('');

	/** @param {any} d */
	function isMuted(d) {
		return d.uuid in mutedAt;
	}

	/** @param {any} d */
	function toggleMute(d) {
		const fader = faderOf(d);
		if (!fader) return;
		if (isMuted(d)) {
			const back = mutedAt[d.uuid];
			const next = { ...mutedAt };
			delete next[d.uuid];
			mutedAt = next;
			setFader(d, back);
		} else {
			mutedAt = { ...mutedAt, [d.uuid]: fader.value };
			setFader(d, 0);
		}
	}

	/** @param {any} d */
	function toggleSolo(d) {
		if (soloed === d.uuid) {
			soloed = '';
			for (const other of devices) if (isMuted(other) && other.uuid !== d.uuid) toggleMute(other);
			return;
		}
		soloed = d.uuid;
		for (const other of devices) if (other.uuid !== d.uuid && !isMuted(other) && faderOf(other)) toggleMute(other);
		if (isMuted(d)) toggleMute(d);
	}
</script>

<div class="music-tbx" id="music-tbx">
	{#if !devices.length}
		<span class="tbx-label">Devices</span>
		<div class="tbx-row music-empty">No devices in the scene. Add one from the viewport menu ▸ Add ▸ Devices.</div>
	{:else}
		<span class="tbx-label">Device</span>
		<div class="tbx-row">
			<select id="music-device-pick" class="music-select" value={current?.uuid ?? ''} onchange={(e) => (pickedUuid = /** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
				{#each devices as d (d.uuid)}
					<option value={d.uuid}>{d.name}</option>
				{/each}
			</select>
		</div>
		{#if current}
			{#if !current.spec}
				<div class="tbx-row music-empty">"{current.doc.kind}" is not installed here — its settings are kept, not editable.</div>
			{:else if !params.length}
				<div class="tbx-row music-empty">This device has no settings.</div>
			{/if}
			{#each params as p (p.key)}
				<div class="music-param" data-key={p.key}>
					{#if p.kind === 'select'}
						<div class="tbx-row music-field">
							<span class="music-field-label">{p.label ?? p.key}</span>
							<select class="music-select" value={current.doc.params[p.key]} onchange={(e) => change(current.uuid, p.key, /** @type {HTMLSelectElement} */ (e.currentTarget).value)}>
								{#each p.options ?? [] as opt}
									<option value={opt.value}>{opt.label ?? opt.value}</option>
								{/each}
							</select>
						</div>
					{:else if p.kind === 'toggle'}
						<label class="tbx-check music-field">
							<input type="checkbox" checked={!!current.doc.params[p.key]} onchange={(e) => change(current.uuid, p.key, /** @type {HTMLInputElement} */ (e.currentTarget).checked)} />
							<span>{p.label ?? p.key}</span>
						</label>
					{:else}
						<DragRow
							label={p.label ?? p.key}
							value={Number(current.doc.params[p.key] ?? p.default ?? 0)}
							min={p.min}
							max={p.max}
							step={(Number(p.max ?? 1) - Number(p.min ?? 0)) / 240}
							snap={p.step ?? 0.01}
							decimals={p.step && p.step >= 1 ? 0 : 2}
							onchange={(v) => change(current.uuid, p.key, v)}
							onscrubstart={() => scrubStart(current.uuid)}
							onscrubend={() => scrubEnd(current.uuid)}
						/>
					{/if}
				</div>
			{/each}

			<span class="tbx-label">Presets</span>
			<div class="tbx-row music-presets">
				<select id="music-preset-pick" class="music-select" bind:value={presetPick}>
					<option value="">—</option>
					{#each presets as p (p.name)}
						<option value={p.name}>{p.name}</option>
					{/each}
				</select>
				<button id="music-preset-apply" class="tbx-primary" disabled={!presetPick} onclick={applyPickedPreset}>Apply</button>
				<button id="music-preset-delete" class="tbx-btn tbx-danger" title="Delete preset" disabled={!presetPick} onclick={deletePickedPreset}>✕</button>
			</div>
			<div class="tbx-row music-presets">
				<input id="music-preset-name" class="music-input" placeholder="Save as…" bind:value={presetName} onkeydown={(e) => { if (e.key === 'Enter') saveCurrentPreset(); }} />
				<button id="music-preset-save" class="tbx-primary" disabled={!presetName.trim()} onclick={saveCurrentPreset}>Save</button>
			</div>
		{/if}

		<span class="tbx-label">Mixer</span>
		{#each devices as d (d.uuid)}
			{@const fader = faderOf(d)}
			<div class="music-mix-row" data-uuid={d.uuid} class:music-current={current?.uuid === d.uuid}>
				<button class="music-mix-name" title="Show this device's settings" onclick={() => (pickedUuid = d.uuid)}>{d.name}</button>
				<div class="music-meter-track"><div class="music-meter" style:width="{Math.min(100, Math.round((levels[d.uuid] ?? 0) * 300))}%"></div></div>
				{#if fader}
					<div class="music-fader">
						<DragRow value={fader.value} min={0} max={fader.max} step={0.01} decimals={2} onchange={(v) => setFader(d, v)} />
					</div>
					<button class="tbx-btn music-mute" aria-pressed={isMuted(d)} title="Mute" onclick={() => toggleMute(d)}>M</button>
					<button class="tbx-btn music-solo" aria-pressed={soloed === d.uuid} title="Solo" onclick={() => toggleSolo(d)}>S</button>
				{:else}
					<span class="music-nofader" title="No level to drive: no level param and no outgoing cable">—</span>
				{/if}
			</div>
		{/each}
	{/if}
</div>

<style>
	.music-tbx {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
	}
	.music-empty {
		color: var(--tbx-muted, #9ca3af);
		font-size: 0.75rem;
		line-height: 1.2;
	}
	.music-select,
	.music-input {
		flex: 1;
		min-width: 0;
		background: var(--surface-2, #1f2937);
		color: var(--tbx-text, #d1d5db);
		border: 1px solid var(--tbx-border, rgb(55 65 81 / 0.6));
		border-radius: 4px;
		font-size: 0.75rem;
		padding: 2px 4px;
	}
	.music-field {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.75rem;
	}
	.music-field-label {
		flex: 0 0 auto;
		color: var(--tbx-muted, #9ca3af);
	}
	.music-presets {
		display: flex;
		gap: 4px;
		align-items: center;
	}
	.music-mix-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 40px minmax(0, 1.2fr) 24px 24px;
		align-items: center;
		gap: 4px;
		width: 100%;
	}
	.music-mix-row.music-current .music-mix-name {
		color: var(--tbx-accent, #2563eb);
	}
	.music-mix-name {
		text-align: left;
		font-size: 0.75rem;
		color: var(--tbx-text, #d1d5db);
		background: none;
		border: none;
		padding: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}
	.music-meter-track {
		height: 6px;
		border-radius: 3px;
		background: var(--tbx-border, rgb(55 65 81 / 0.6));
		overflow: hidden;
	}
	.music-meter {
		height: 100%;
		background: #4ade80;
		transition: width 80ms linear;
	}
	.music-mix-row .tbx-btn {
		width: 24px;
		height: 24px;
		font-size: 0.7rem;
	}
	.music-nofader {
		grid-column: 3 / -1;
		color: var(--tbx-muted, #9ca3af);
		font-size: 0.75rem;
		text-align: center;
	}
</style>
