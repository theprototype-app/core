<script module>
	import { minimalScroll } from '$lib/ui/minimalScroll.js';
	import { vrSettingsKeywords, VR_SETTINGS, VR_SETTING_PAGES } from '$lib/vr/settingsSchema.js';
	import { registerSettingsKeywords } from '$lib/settingsSearch';
	/** I4 settings search: every label + keyword of the VR section */
	export const keywords = vrSettingsKeywords();
	// 36-int-122: the I4 search reads keywords by ROW NAME (a word on the whole section would list
	// every VR row) — each row answers to its own words + its page's name ("snap comfort" → Comfort)
	for (const r of VR_SETTINGS) {
		const page = VR_SETTING_PAGES.find((p) => p.id === r.page);
		registerSettingsKeywords(r.label, [...(r.keywords ?? []), ...(page ? [page.label] : [])]);
	}
	// 37-settings: the old labels of the rows this redesign renamed (Decision C) + the new rows' words
	registerSettingsKeywords('play on the screen, even in a headset', ['vr override', 'override', 'flat', 'desktop', 'immersive']);
	registerSettingsKeywords('remap buttons', ['bindings', 'buttons', 'controller', 'remap', 'left-handed', 'swap']);
	registerSettingsKeywords('my hand model', ['custom hands', 'hands', 'glb', 'identity', 'avatar']);
	registerSettingsKeywords('colocation', ['colocate', 'room', 'same room', 'anchor', 'mixed reality']);
	registerSettingsKeywords('fine-tune', ['nudge', 'offset', 'calibrate', 'colocation']);
	registerSettingsKeywords('ghost hands', ['colocated', 'room-mate', 'hands']);
	registerSettingsKeywords('colocation probe', ['colocation probe (dev)', 'ar', 'probe', 'anchor', 'dev']);
</script>

<script>
	// Settings ▸ VR (36-vr, U3): every VR setting, rendered from the ONE settings table the headset uses
	// (vr/settingsSchema.js) — the same names, groups and order as the radial's Settings rings and the
	// in-headset panel — plus the VR button remap (plan 55). Every row writes through the schema's own
	// setter, which also persists it under the key it always had.
	//
	// 37-settings (R21, docs/settings-inventory.md §3.10): the WHOLE VR page on the redesign kit —
	// General, the schema's pages as cards (toggles; 2–4 choices as segmented controls; Height as a
	// slider with its readout; the "· now X" suffix gone, the control shows it), the remap table as a
	// SUB-PAGE ("VR › Remap buttons"), Avatar, Colocation (its Fine-tune is a sub-page while
	// colocated) and Advanced (the dev-only Colocation probe).
	import { getContext } from 'svelte';
	import Section from '../ui/Section.svelte';
	import SettingRow from '../ui/SettingRow.svelte';
	import NavRow from '../ui/NavRow.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import Slider from '../ui/Slider.svelte';
	import Button from '../ui/Button.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import { NAV_CONTEXT } from '$lib/settingsNav';
	import { vrSettingsVersion } from '$lib/vr/settingsSchema.js';
	import { VR_ACTIONS, CONTROLS_FOR, vrBindings, setBinding, resetBindings, controlName, actionInfo } from '$lib/vr/bindings.js';
	import { showToast } from '../../stores/appStore.js';
	import { vrOverride } from '../../stores/sceneStore.js';
	import { safeStorage } from '$lib/safeStorage';
	import { myHandModel, setMyHandModel } from '$lib/handModels';
	import { explorerItems } from '$lib/explorer';
	import { probeFindings, probeRunning, probeSupport, runArProbe, clearProbeState } from '$lib/arProbe';
	import { roomAlignment, roomNudge, nudgeIsZero, NUDGE_MAX_M } from '$lib/colocation';
	import { setRoomNudge, resetRoomNudge } from '$lib/colocationNudge';
	import { colocatedGhostHands } from '$lib/colocationPresence';
	import { colocateHereFromView, stopColocation } from '$lib/colocationCalibrate';
	import { anchorRecords, forgetRoom, forgetCandidate } from '$lib/colocationAnchors';

	const nav = /** @type {any} */ (getContext(NAV_CONTEXT));
	const sub = nav?.sub;
	const page = $derived($sub?.id === 'vr:remap' ? 'remap' : $sub?.id === 'vr:finetune' ? 'finetune' : 'main');

	// passthrough capability probe (90): the setting stays visible with a hint
	/** @type {boolean | null} */
	let arSupport = $state(null);
	if (typeof navigator !== 'undefined') {
		/** @type {any} */ (navigator).xr
			?.isSessionSupported?.('immersive-ar')
			.then((/** @type {boolean} */ ok) => (arSupport = ok))
			.catch(() => (arSupport = false));
	}

	/** the rows of a page on the desktop (rows living elsewhere there are skipped) @param {string} id */
	const desktopRows = (id) => VR_SETTINGS.filter((r) => r.page === id && r.desktop !== false);
	/** re-read every value whenever any VR setting changes @param {any} row @param {number} _v */
	const valueOf = (row, _v) => row.get?.();
	/** 37-settings: the spec asks Mirror turn for a description (the schema's notes are shared with
	 * the headset, so the desktop-only ones live here) */
	const DESKTOP_NOTES = /** @type {Record<string, string>} */ ({
		mirror: 'A left flick turns you right, and the other way round.',
		turning: 'How the turn stick turns you.',
		snapAngle: 'How far one flick turns you.',
		smoothSpeed: 'How fast a smooth turn is.',
		height: 'Raise or lower your view.',
		gameHudSize: 'How big a game’s HUD text is.',
		faceCap: 'The most triangles a mesh may have for face editing in VR.',
		vertexCap: 'The most vertices a mesh may have for vertex editing in VR.'
	});
	/** @param {any} row */
	const noteOf = (row) => {
		const n = row.note || DESKTOP_NOTES[row.id] || '';
		// the schema's notes are shared with the headset and carry no full stop; a description does
		return n && !/[.!?]$/.test(n) ? n + '.' : n;
	};
	/** @param {any} row */
	const optionsOf = (row) => (row.options ?? []).map((/** @type {any} */ o) => ({ value: String(o.value), label: o.label }));
	/** a choice row's value back to the type its options carry (snap angles are numbers) @param {any} row @param {string} v */
	function coerce(row, v) {
		const hit = (row.options ?? []).find((/** @type {any} */ o) => String(o.value) === v);
		return hit ? hit.value : v;
	}
	const cm = (/** @type {number} */ v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(Math.round(v * 100)) + ' cm';

	/** "VR override": the store, plus the key written only while it is ON (as 1.25.0's checkbox did) @param {boolean} on */
	function setOverride(on) {
		vrOverride.set(on);
		if (on) safeStorage.setItem('vrOverride', 'true');
		else safeStorage.removeItem('vrOverride');
	}

	// ---- the remap table (plan 55): LOCAL — each person maps their own controllers ----
	const HANDS = [
		{ value: 'left', label: 'Left' },
		{ value: 'right', label: 'Right' }
	];
	/** @param {string} kind @param {string} hand */
	const controlItems = (kind, hand) =>
		(/** @type {any} */ (CONTROLS_FOR)[kind] ?? []).map((/** @type {any} */ c) => ({ value: c, name: controlName(/** @type {any} */ (hand), c) }));
	/** a refused move waiting for Swap / Cancel @type {{id: string, want: any, other: string} | null} */
	let pending = $state(null);
	/** @param {string} id @param {any} patch */
	function rebind(id, patch) {
		const r = setBinding(id, patch);
		pending = !r.ok && r.conflict ? { id, want: { ...$vrBindings[id], ...patch }, other: r.conflict } : null;
	}
	function swapPending() {
		if (!pending) return;
		const r = setBinding(pending.id, pending.want, { swap: true });
		if (r.ok && r.swapped)
			showToast(actionInfo(pending.id)?.label + ' moved · ' + r.swapped.split(',').map((a) => actionInfo(a)?.label).join(', ') + ' took its old place');
		pending = null;
	}
	/** @param {string} id */
	const labelOf = (id) => actionInfo(id)?.label ?? id;
	const leftHandedRow = VR_SETTINGS.find((r) => r.id === 'leftHanded');

	// CO3: which stored room anchor Forget offers — the current room when aligned, else the newest record
	const forgetKey = $derived(forgetCandidate($anchorRecords, $roomAlignment));
	const handModels = $derived($explorerItems.filter((/** @type {any} */ i) => i.kind === 'object'));
</script>

{#snippet schemaRow(/** @type {any} */ row)}
	<SettingRow
		id={'row-vr-' + row.id}
		label={row.label}
		description={noteOf(row) + (row.id === 'passthrough' && arSupport === false ? ' Not supported on this device.' : '')}
		wide={row.kind === 'choice' && (row.options?.length ?? 0) >= 3 && row.id !== 'faceCap' && row.id !== 'vertexCap'}
		data-tour={row.tour}
	>
		{#if row.kind === 'toggle'}
			<Toggle id={row.id === 'passthrough' ? 'passthrough-toggle' : 'vr-set-' + row.id} label={row.label} checked={!!valueOf(row, $vrSettingsVersion)} onchange={(on) => row.set?.(on)} />
		{:else if row.kind === 'choice' && (row.id === 'faceCap' || row.id === 'vertexCap')}
			<!-- the edit limits keep a free number on the desktop (the headset cycles presets) -->
			<input
				id={'vr-set-' + row.id}
				class="settings-num"
				type="number"
				min="10"
				step="50"
				aria-label={row.label}
				value={valueOf(row, $vrSettingsVersion)}
				onchange={(e) => {
					const v = parseInt(e.currentTarget.value);
					if (Number.isFinite(v) && v >= 10) row.set?.(v);
				}}
			/>
		{:else if row.kind === 'choice'}
			<Segmented id={'vr-set-' + row.id} label={row.label} options={optionsOf(row)} value={String(valueOf(row, $vrSettingsVersion))} onchange={(v) => row.set?.(coerce(row, v))} />
		{:else if row.kind === 'range'}
			<Slider id={'vr-set-' + row.id} label={row.label} min={row.min} max={row.max} step={row.step ?? 0.05} value={Number(valueOf(row, $vrSettingsVersion)) || 0} format={row.id === 'height' ? cm : (v) => String(v)} onchange={(v) => row.set?.(v)} />
		{:else}
			<Button id={'vr-set-' + row.id} size="sm" variant="outline" onclick={() => row.run?.()}>Reset</Button>
		{/if}
	</SettingRow>
{/snippet}

<div class="vr-settings contents" data-tour="settings-vr">
	{#if page === 'remap'}
		<Section variant="card" label="Buttons" badge="This device">
			{#each VR_ACTIONS as a (a.id)}
				{@const b = $vrBindings[a.id]}
				<SettingRow id={'row-vr-bind-' + a.id} label={a.label} description={a.doc} data-action={a.id} wide={a.kind === 'button'}>
					{#if a.kind === 'locked'}
						<span class="vr-locked">Both · {controlName('both', b.control)}</span>
					{:else}
						<!-- re-keyed on the binding: a refused pick (a conflict you Cancel) snaps back to the truth -->
						{#key b.hand + '|' + b.control + '|' + (pending ? pending.id : '')}
							<Segmented id={'vr-bind-' + a.id + '-hand'} label={a.label + ' hand'} options={HANDS} value={b.hand} onchange={(v) => rebind(a.id, { hand: v })} />
							{#if a.kind === 'button'}
								<ThemedSelect id={'vr-bind-' + a.id + '-control'} items={controlItems(a.kind, b.hand)} value={b.control} onchange={(v) => rebind(a.id, { control: v })} />
							{:else}
								<span class="vr-locked">{controlName(b.hand, b.control)}</span>
							{/if}
						{/key}
					{/if}
					{#snippet extra()}
						{#if pending?.id === a.id}
							<div class="vr-conflict" role="alert" id="vr-bind-conflict">
								<span>{controlName(pending.want.hand, pending.want.control)} is already {labelOf(pending.other)}.</span>
								<Button id="vr-bind-swap" size="sm" variant="outline" onclick={swapPending}>Swap them</Button>
								<Button id="vr-bind-cancel" size="sm" variant="ghost" onclick={() => (pending = null)}>Cancel</Button>
							</div>
						{/if}
					{/snippet}
				</SettingRow>
			{/each}
		</Section>
		<Section variant="card" label="Handedness">
			{#if leftHandedRow}{@render schemaRow(leftHandedRow)}{/if}
			<SettingRow id="row-vr-bind-reset" label="Reset buttons" description="Every button back to the default map. The headset has the same table: Settings ▸ Controls ▸ Remap buttons.">
				<Button
					id="vr-bind-reset"
					size="sm"
					variant="outline"
					onclick={() => {
						resetBindings();
						pending = null;
						showToast('VR buttons reset to the defaults');
					}}>Reset</Button
				>
			</SettingRow>
		</Section>
	{:else if page === 'finetune'}
		<Section variant="card" label="Fine-tune" badge="This device">
			<SettingRow id="row-vr-nudge" label="Nudge the room" description="Line the world up with what you see — yours alone, remembered per room. To move the scene for everyone, two-grip grab it." wide>
				{#snippet extra()}
					<div class="vr-nudge">
						<DragRow id="nudge-dx" label="X" value={$roomNudge?.dx ?? 0} unit="length" step={0.002} snap={0.01} decimals={3} min={-NUDGE_MAX_M} max={NUDGE_MAX_M} onchange={(v) => setRoomNudge({ dx: v })} />
						<DragRow id="nudge-dy" label="Y" value={$roomNudge?.dy ?? 0} unit="length" step={0.002} snap={0.01} decimals={3} min={-NUDGE_MAX_M} max={NUDGE_MAX_M} onchange={(v) => setRoomNudge({ dy: v })} />
						<DragRow id="nudge-dz" label="Z" value={$roomNudge?.dz ?? 0} unit="length" step={0.002} snap={0.01} decimals={3} min={-NUDGE_MAX_M} max={NUDGE_MAX_M} onchange={(v) => setRoomNudge({ dz: v })} />
						<DragRow
							id="nudge-dyaw"
							label="Yaw"
							value={($roomNudge?.dyaw ?? 0) * (180 / Math.PI)}
							unit="angleDeg"
							step={0.05}
							snap={0.5}
							decimals={2}
							min={-15}
							max={15}
							onchange={(v) => setRoomNudge({ dyaw: (v * Math.PI) / 180 })}
						/>
					</div>
				{/snippet}
			</SettingRow>
			<SettingRow id="row-vr-nudge-reset" label="Reset the nudge" description="Back to the calibration as measured.">
				<Button id="nudge-reset" size="sm" variant="outline" disabled={nudgeIsZero($roomNudge)} onclick={() => resetRoomNudge()}>Reset</Button>
			</SettingRow>
		</Section>
	{:else}
		<Section variant="card" label="General" badge="This device">
			<SettingRow id="row-vr-override" label="Play on the screen, even in a headset" description="Ignores immersive VR and plays on the flat screen.">
				<Toggle id="vr-override" label="Play on the screen, even in a headset" checked={!!$vrOverride} onchange={setOverride} />
			</SettingRow>
		</Section>
		{#each VR_SETTING_PAGES as p (p.id)}
			{#if desktopRows(p.id).length}
				<Section variant="card" label={p.label}>
					{#each desktopRows(p.id) as row (row.id)}{@render schemaRow(row)}{/each}
					{#if p.id === 'controls'}
						<NavRow id="vr-remap-open" label="Remap buttons" description="Which hand and button does what." data-tour="settings-vr-controls" onclick={() => nav.openSub('vr:remap', 'Remap buttons', 'vr')} />
					{/if}
				</Section>
			{/if}
		{/each}
		<Section variant="card" label="Avatar">
			<SettingRow id="row-vr-hand-model" label="My hand model" badge="Shared" description="A GLB from your library that others see as your hands in VR.">
				<select id="my-hand-model" class="vr-select" aria-label="My hand model" value={$myHandModel} onchange={(e) => setMyHandModel(e.currentTarget.value)}>
					<option value="">Default</option>
					{#each handModels as item (item.id)}
						<option value={item.hash}>{item.name}</option>
					{/each}
				</select>
			</SettingRow>
		</Section>
		<Section variant="card" label="Colocation">
			<SettingRow id="row-vr-colocation" label="Colocation" wide>
				{#snippet desc()}<span id="colocation-state">{$roomAlignment ? 'Colocated · ' + ($roomAlignment.roomKey ?? 'room') : 'Not colocated'}</span> — share one physical room with a co-present peer. Stand on the agreed spot facing the agreed way, then press Colocate here.{/snippet}
				<Button id="colocate-here" size="sm" variant="outline" onclick={() => colocateHereFromView()}>Colocate here</Button>
				<Button id="colocate-stop" size="sm" variant="outline" disabled={!$roomAlignment} onclick={() => stopColocation()}>Stop</Button>
				{#if forgetKey}
					<Button
						id="colocate-forget"
						size="sm"
						variant="ghost"
						title={'Forget the saved room anchor for ' + forgetKey + ' — the next visit needs the ritual again. Stop does NOT forget.'}
						onclick={() => forgetRoom(forgetKey)}>Forget {forgetKey}</Button
					>
				{/if}
			</SettingRow>
			{#if $roomAlignment}
				<NavRow id="vr-finetune-open" label="Fine-tune" description="Nudge the room to line up with what you see." onclick={() => nav.openSub('vr:finetune', 'Fine-tune', 'vr')} />
			{/if}
			<SettingRow id="row-vr-ghost-hands" label="Ghost hands" badge="This device" description="While colocated, a room-mate’s hands stay, drawn faint; their body, label and voice are hidden.">
				<Toggle id="colocated-ghost-hands" label="Ghost hands" bind:checked={$colocatedGhostHands} />
			</SettingRow>
		</Section>
		<Section variant="card" label="Advanced">
			<SettingRow id="row-vr-probe" label="Colocation probe" badge="Dev" wide>
				{#snippet desc()}Run it inside the headset, restart the browser, run it again: the second run’s restore delta is the answer.{arSupport === false ? ' This device reports no immersive-ar support.' : ''}{/snippet}
				<Button
					id="ar-probe-run"
					size="sm"
					variant="outline"
					disabled={$probeRunning}
					onclick={() => {
						// USER ACTIVATION, and this ORDER is the whole reason for the comment: probeSupport() is
						// STARTED and deliberately NOT awaited, so runArProbe() — whose first statement is the
						// requestSession call — runs in the SAME task as this click
						probeSupport();
						runArProbe();
					}}>{$probeRunning ? 'Probing…' : 'Probe AR capabilities'}</Button
				>
				<Button id="ar-probe-clear" size="sm" variant="ghost" disabled={$probeRunning} onclick={() => clearProbeState()}>Clear stored anchor</Button>
				{#snippet extra()}
					{#if $probeFindings.length}
						<div class="vr-probe" id="ar-probe-report" use:minimalScroll>
							{#each $probeFindings as finding, i (i)}
								<div class="vr-probe-row">
									<span class={finding.ok ? 'vr-ok' : 'vr-bad'}>{finding.ok ? '✓' : '✗'}</span>
									<span class="vr-probe-step">{finding.step}</span>
									<span class="vr-probe-detail">{finding.detail}</span>
								</div>
							{/each}
						</div>
					{/if}
				{/snippet}
			</SettingRow>
		</Section>
	{/if}
</div>

<style>
	.contents {
		display: contents;
	}
	.vr-locked {
		font-size: var(--fs-desc);
		color: var(--text-faint);
	}
	.vr-conflict {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 8px;
		font-size: var(--fs-desc);
		color: var(--warn-text);
	}
	.vr-select {
		max-width: 200px;
		height: var(--control-h-sm);
		padding: 0 8px;
		border: 1px solid var(--border-input);
		border-radius: 6px;
		background: var(--surface-inset);
		color: var(--text);
		font: inherit;
		font-size: var(--fs-desc);
	}
	.vr-nudge {
		display: flex;
		flex-wrap: wrap;
		gap: 8px 16px;
	}
	.vr-probe {
		display: flex;
		flex-direction: column;
		gap: 2px;
		max-height: 18rem;
		overflow-y: auto;
		font-family: var(--font-ui-mono);
		font-size: 11px;
		line-height: 1.4;
	}
	.vr-probe-row {
		display: flex;
		gap: 6px;
	}
	.vr-probe-step {
		font-weight: 600;
		white-space: nowrap;
		color: var(--text);
	}
	.vr-probe-detail {
		min-width: 0;
		overflow-wrap: anywhere;
		color: var(--text-muted);
	}
	.vr-ok {
		color: var(--ink-good);
	}
	.vr-bad {
		color: var(--ink-bad);
	}
	@media (max-width: 639.98px) {
		.vr-select {
			height: 44px;
			font-size: 16px;
		}
	}
</style>
