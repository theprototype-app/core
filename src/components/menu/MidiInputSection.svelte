<script>
	// 75 MU1 — the Music toolbox's MIDI row: connect a hardware keyboard / pad controller,
	// pick the device it plays, see what arrived. Everything here is LOCAL (midiInput.js);
	// the notes themselves replicate through the ordinary device-note path.
	import { onMount } from 'svelte';
	import { objectsGroup, selectedObject } from '../../stores/sceneStore';
	import { deviceCatalogVersion } from '$lib/audioDevices';
	import { midiState, midiTarget, enableMidi, disableMidi, noteDevices, resolveMidiTarget, noteName } from '$lib/midiInput';
	import { safeStorage } from '$lib/safeStorage';

	/** the in-app explanation shown before the browser's own prompt, the first time */
	let explaining = $state(false);
	/** re-read the target / list when the scene, the catalogue or the selection change */
	let tick = $state(0);
	const devices = $derived.by(() => {
		void tick;
		void $objectsGroup;
		void $deviceCatalogVersion;
		return noteDevices();
	});
	const target = $derived.by(() => {
		void tick;
		void $objectsGroup;
		void $selectedObject;
		void $midiTarget;
		return resolveMidiTarget();
	});
	const targetName = $derived(devices.find((d) => d.uuid === target)?.name ?? '');
	/** a note flashes in the readout for a moment after it arrives */
	let now = $state(Date.now());
	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 250);
		return () => clearInterval(timer);
	});
	const lastFresh = $derived(!!$midiState.last && now - $midiState.last.at < 1500);

	function connect() {
		// the explanation once per browser: after a first connect the button goes straight
		// to the browser (which remembers its own answer)
		if (safeStorage.getItem('midiInput') === null) explaining = true;
		else void enableMidi();
	}
	function allow() {
		explaining = false;
		void enableMidi();
	}
	/** @param {Event} e */
	function pickTarget(e) {
		midiTarget.set(/** @type {HTMLSelectElement} */ (e.currentTarget).value);
		tick++;
	}
</script>

<span class="tbx-label">MIDI input</span>
<div class="midi-row" id="music-midi">
	{#if $midiState.status === 'unsupported'}
		<p class="midi-note" id="midi-status">This browser has no Web MIDI. Chrome and Edge have it.</p>
	{:else if explaining}
		<p class="midi-note" id="midi-explain">
			Your browser will ask to let this site use MIDI devices. The notes you play are heard by everyone in the session.
		</p>
		<div class="midi-actions">
			<button id="midi-allow" class="tbx-primary" onclick={allow}>Allow MIDI</button>
			<button id="midi-not-now" class="tbx-btn" onclick={() => (explaining = false)}>Not now</button>
		</div>
	{:else if $midiState.status === 'off'}
		<div class="midi-actions">
			<button id="midi-connect" class="tbx-primary" onclick={connect}>Connect MIDI keyboard</button>
		</div>
	{:else if $midiState.status === 'asking'}
		<p class="midi-note" id="midi-status" aria-live="polite">Waiting for the browser…</p>
	{:else if $midiState.status === 'denied' || $midiState.status === 'error'}
		<p class="midi-note midi-warn" id="midi-status" aria-live="polite">
			{$midiState.status === 'denied'
				? "MIDI is blocked for this site. Allow it in the browser's site settings, then try again."
				: 'MIDI did not start: ' + $midiState.error}
		</p>
		<div class="midi-actions">
			<button id="midi-retry" class="tbx-btn" onclick={() => void enableMidi()}>Try again</button>
		</div>
	{:else}
		<p class="midi-note" id="midi-inputs">
			{#if $midiState.inputs.length}
				{$midiState.inputs.map((i) => i.name).join(', ')}
			{:else}
				No MIDI device plugged in — connect one and it appears here.
			{/if}
		</p>
		<label class="midi-field">
			<span class="midi-field-label">Play on</span>
			<select id="midi-target" class="midi-select" value={$midiTarget} onchange={pickTarget}>
				<option value="">{targetName ? 'Selected device (' + targetName + ')' : 'Selected device'}</option>
				{#each devices as d (d.uuid)}
					<option value={d.uuid}>{d.name}</option>
				{/each}
			</select>
		</label>
		<p class="midi-note" id="midi-last" aria-live="off">
			{#if !target}
				{devices.length ? 'Select a device to play it.' : 'No device in the scene plays notes.'}
			{:else if lastFresh && $midiState.last}
				<span class="midi-lit">{noteName($midiState.last.note)}</span> · velocity {Math.round($midiState.last.velocity * 127)}
			{:else}
				Ready.
			{/if}
		</p>
		<div class="midi-actions">
			<button id="midi-disconnect" class="tbx-btn" onclick={disableMidi}>Disconnect</button>
		</div>
	{/if}
</div>

<style>
	.midi-row {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 100%;
	}
	.midi-note {
		margin: 0;
		color: var(--tbx-muted);
		font-size: 0.75rem;
		line-height: 1.25;
	}
	.midi-warn {
		color: var(--ink-warn);
	}
	.midi-lit {
		color: var(--accent-text);
		font-weight: 600;
	}
	.midi-actions {
		display: flex;
		gap: 4px;
		align-items: center;
	}
	/* a finger needs a bigger target than the toolbox's compact desktop buttons */
	@media (pointer: coarse) {
		.midi-actions button,
		.midi-select {
			min-height: 36px;
		}
	}
	.midi-field {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: 0.75rem;
	}
	.midi-field-label {
		flex: 0 0 auto;
		color: var(--tbx-muted);
	}
	.midi-select {
		flex: 1;
		min-width: 0;
		background: var(--surface-2);
		color: var(--tbx-text);
		border: 1px solid var(--tbx-border);
		border-radius: 4px;
		font-size: 0.75rem;
		padding: 2px 4px;
	}
</style>
