<script module>
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	// the old labels of the rows this redesign renamed (Decision C) + the words people search with
	const ROW_WORDS = {
		'shift+a opens the add menu': ['shift+a quick add', 'quick add', 'add menu', 'spawn'],
		'show helpers in play': ['show helpers in play (debug)', 'debug', 'light helpers', 'frustum'],
		'trackpad gestures': ['touchpad', 'mac', 'wheel'],
		'two-finger pan': ['touchpad', 'trackpad'],
		'reverse trackpad pan': ['touchpad', 'invert', 'natural scrolling'],
		'pinch zoom': ['touchpad', 'trackpad'],
		'allow browser pinch zoom': ['accessibility', 'page zoom', 'ctrl+scroll'],
		'wheel diagnostics': ['wheel', 'mouse', 'scroll', 'debug', 'steam deck']
	};
	for (const [row, words] of Object.entries(ROW_WORDS)) registerSettingsKeywords(row, words);
</script>

<script>
	// 37-settings (R21) — Settings ▸ Controls on the redesign kit (docs/settings-inventory.md §3.2).
	// Same stores / keys as 1.25.0; the wheel diagnostics are a collapsed "Diagnostics" block (spec).
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Toggle from '../../ui/Toggle.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import Button from '../../ui/Button.svelte';
	import { enableShiftAdd, noteDoubleClickToOpen } from '../../../stores/appStore.js';
	import { helpersInPlay } from '$lib/helperLayer';
	import { trackpadMode, allowBrowserZoom, reversePan, panEnabled, pinchZoomEnabled, lastWheelEvents } from '$lib/trackpadNav';

	// 24-A2.1: the wheel diagnostics readout's static half — WHAT machine this is
	const wheelPlatform =
		typeof navigator === 'undefined'
			? ''
			: String(/** @type {any} */ (navigator).userAgentData?.platform || navigator.platform || '') +
				(/Firefox/.test(navigator.userAgent) ? ' · Firefox' : /Chrom/.test(navigator.userAgent) ? ' · Chromium' : /Safari/.test(navigator.userAgent) ? ' · Safari' : '');
	const wheelCoarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
	/** @param {number | null | undefined} n */
	const fmt = (n) => (n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : n.toFixed(2));
	let showWheel = $state(false);

	const TRACKPAD_MODES = [
		{ value: 'auto', label: 'Auto' },
		{ value: 'on', label: 'On' },
		{ value: 'off', label: 'Off' }
	];
</script>

<div class="settings-page-body" data-keywords="mouse trackpad touchpad keyboard">
	<Section variant="card" label="Keyboard & mouse">
		<SettingRow id="row-shift-add" label="Shift+A opens the Add menu" description="Spawns the picked object under the cursor. Off by default, since Shift also strafes in fly mode.">
			<Toggle id="shift-add" label="Shift+A opens the Add menu" bind:checked={$enableShiftAdd} />
		</SettingRow>
		<SettingRow id="row-helpers-play" label="Show helpers in Play" badge="Debug" description="Light helpers and camera frustums stay visible in Play, with a DEBUG chip.">
			<Toggle id="helpers-in-play" label="Show helpers in Play" bind:checked={$helpersInPlay} />
		</SettingRow>
		<SettingRow id="row-note-dblclick" label="Double-click to open notes" description="A single click on a note only flies the camera to it.">
			<Toggle id="note-dblclick" label="Double-click to open notes" bind:checked={$noteDoubleClickToOpen} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Trackpad">
		<SettingRow id="row-trackpad-mode" label="Trackpad gestures" description="Two-finger swipes pan and pinch zooms. Auto tells a trackpad from a mouse wheel.">
			<Segmented id="trackpad-mode" label="Trackpad gestures" options={TRACKPAD_MODES} value={$trackpadMode} onchange={(v) => trackpadMode.set(v)} />
		</SettingRow>
		<SettingRow id="row-two-finger-pan" label="Two-finger pan" description="When off, swipes zoom like a mouse wheel.">
			<Toggle id="trackpad-pan" label="Two-finger pan" bind:checked={$panEnabled} />
		</SettingRow>
		<SettingRow id="row-reverse-pan" label="Reverse trackpad pan" description="The scene moves against your fingers instead of with them.">
			<Toggle id="trackpad-reverse" label="Reverse trackpad pan" bind:checked={$reversePan} />
		</SettingRow>
		<SettingRow id="row-pinch-zoom" label="Pinch zoom" description="Pinching on the viewport zooms the camera.">
			<Toggle id="trackpad-pinch" label="Pinch zoom" bind:checked={$pinchZoomEnabled} />
		</SettingRow>
		<SettingRow id="row-browser-zoom" label="Allow browser pinch zoom" description="Lets pinch and Ctrl+scroll zoom the whole page (accessibility).">
			<Toggle id="browser-zoom" label="Allow browser pinch zoom" bind:checked={$allowBrowserZoom} />
		</SettingRow>
	</Section>

	<Section variant="card" label="Diagnostics">
		<SettingRow id="row-wheel-diagnostics" label="Wheel diagnostics" description="The last 8 wheel events over the viewport and how each was classified.">
			<Button id="wheel-diagnostics-toggle" size="sm" variant="outline" pressed={showWheel} onclick={() => (showWheel = !showWheel)}>{showWheel ? 'Hide' : 'Show'}</Button>
			{#snippet extra()}
				{#if showWheel}
					<div id="wheel-diagnostics" class="wd">
						<p class="wd-meta">
							{wheelPlatform || 'unknown platform'} · pointer: {wheelCoarse ? 'coarse' : 'fine'} · wheel mode: {$trackpadMode === 'off' ? 'zoom' : $trackpadMode === 'on' ? 'pan' : 'auto'}
						</p>
						{#if $lastWheelEvents.length}
							<div class="wd-scroll" use:minimalScroll>
								<table class="wheel-diag">
									<thead><tr><th>Δt ms</th><th>mode</th><th>ΔX</th><th>ΔY</th><th>wheelΔY</th><th>ctrl</th><th>as</th><th>why</th></tr></thead>
									<tbody>
										{#each $lastWheelEvents as s, i (s.t + ':' + i)}
											<tr data-kind={s.kind}>
												<td>{s.dt}</td><td>{s.deltaMode}</td><td>{fmt(s.deltaX)}</td><td>{fmt(s.deltaY)}</td><td>{fmt(s.wheelDeltaY)}</td><td>{s.ctrl ? '✓' : ''}</td><td>{s.kind}</td><td>{s.why}</td>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{:else}
							<p class="wd-meta">Scroll over the viewport — the last 8 wheel events land here.</p>
						{/if}
						<p class="wd-meta">If a mouse wheel pans instead of zooming (or a trackpad zooms), use Viewport menu ▸ View ▸ Mouse wheel, or Trackpad gestures above.</p>
					</div>
				{/if}
			{/snippet}
		</SettingRow>
	</Section>
</div>

<style>
	.settings-page-body {
		display: contents;
	}
	.wd {
		display: flex;
		flex-direction: column;
		gap: 6px;
		font-size: var(--fs-desc);
	}
	.wd-meta {
		margin: 0;
		color: var(--text-muted);
	}
	.wd-scroll {
		overflow-x: auto;
	}
	.wheel-diag {
		width: 100%;
		border-collapse: collapse;
		font-family: var(--font-ui-mono);
		font-size: 11px;
		color: var(--text-2);
	}
	.wheel-diag th {
		text-align: left;
		font-weight: 500;
		color: var(--text-faint);
	}
	.wheel-diag td,
	.wheel-diag th {
		padding: 2px 6px 2px 0;
	}
</style>
