<script module>
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
</script>

<script>
	// Settings ▸ VR (36-vr, U3): every VR setting, rendered from the ONE settings table the headset uses
	// (vr/settingsSchema.js) — the same names, groups and order as the radial's Settings rings and the
	// in-headset panel — plus the Controls table (plan 55): each VR action's hand + button, a conflict
	// warning with Swap / Cancel, and Reset. Legacy mode on purpose: it drops into the legacy-mode
	// Settings modal beside SettingRow. Every row writes through the schema's own setter, which also
	// persists it under the key it always had.
	import { Checkbox, Toggle } from 'flowbite-svelte';
	import SettingRow from './SettingRow.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { vrSettingsVersion, settingValueText } from '$lib/vr/settingsSchema.js'; // VR_SETTINGS / VR_SETTING_PAGES: the module script's import
	import { VR_ACTIONS, CONTROLS_FOR, vrBindings, setBinding, resetBindings, controlName, actionInfo } from '$lib/vr/bindings.js';
	import { showToast } from '../../stores/appStore.js';

	/** Settings' immersive-ar probe (null = not known yet): Passthrough says when this device cannot */
	/** @type {boolean | null} */
	export let arSupport = null;

	/** the rows of a page on the desktop (rows living elsewhere there are skipped) @param {string} page */
	function desktopRows(page) {
		return VR_SETTINGS.filter((r) => r.page === page && r.desktop !== false);
	}
	// re-read every value whenever any VR setting changes
	$: version = $vrSettingsVersion;
	/** @param {any} row @param {number} _v */
	const valueOf = (row, _v) => row.get?.();
	/** @param {any} row @param {number} _v */
	const nowText = (row, _v) => settingValueText(row);
	/** a range as a list of steps @param {any} row */
	function rangeItems(row) {
		/** @type {{value: number, name: string}[]} */
		const out = [];
		const step = row.step ?? 0.05;
		for (let v = row.min; v <= row.max + 1e-9; v += step) {
			const value = Math.round(v * 100) / 100;
			out.push({ value, name: row.format ? row.format(value) : String(value) });
		}
		return out;
	}

	// ---- the Controls table ----
	const HANDS = [
		{ value: 'left', name: 'Left' },
		{ value: 'right', name: 'Right' }
	];
	/** @param {string} kind @param {string} hand */
	const controlItems = (kind, hand) =>
		(/** @type {any} */ (CONTROLS_FOR)[kind] ?? []).map((/** @type {any} */ c) => ({ value: c, name: controlName(/** @type {any} */ (hand), c) }));
	/** @type {{id: string, want: any, other: string} | null} a refused move waiting for Swap / Cancel */
	let pending = null;
	/** @param {string} id @param {any} patch */
	function rebind(id, patch) {
		const r = setBinding(id, patch);
		pending = !r.ok && r.conflict ? { id, want: { ...$vrBindings[id], ...patch }, other: r.conflict } : null;
	}
	function swapPending() {
		if (!pending) return;
		const r = setBinding(pending.id, pending.want, { swap: true });
		if (r.ok && r.swapped)
			showToast(
				actionInfo(pending.id)?.label + ' moved · ' + r.swapped.split(',').map((a) => actionInfo(a)?.label).join(', ') + ' took its old place'
			);
		pending = null;
	}
	/** @param {string} id */
	const labelOf = (id) => actionInfo(id)?.label ?? id;
</script>

<div class="vr-settings" data-tour="settings-vr">
	{#each VR_SETTING_PAGES as page (page.id)}
		{#if desktopRows(page.id).length}
			<h3 class="vr-sub" data-tour={'settings-vr-' + page.id}>{page.label}</h3>
			{#each desktopRows(page.id) as row (row.id)}
				<SettingRow name={row.label}>
					<svelte:fragment slot="control">
						{#if row.id === 'passthrough'}
							<!-- a red SWITCH (98): reads as an armed mode, not a plain option -->
							<Toggle
								id="passthrough-toggle"
								color="red"
								size="small"
								checked={!!valueOf(row, version)}
								onchange={(/** @type {any} */ e) => row.set?.(e.target.checked)} />
						{:else if row.kind === 'toggle'}
							<Checkbox
								id={'vr-set-' + row.id}
								checked={!!valueOf(row, version)}
								onchange={(/** @type {any} */ e) => row.set?.(e.target.checked)} />
						{:else if row.kind === 'choice' && (row.id === 'faceCap' || row.id === 'vertexCap')}
							<!-- the edit limits keep a free number on the desktop (the headset cycles presets) -->
							<input
								id={'vr-set-' + row.id}
								type="number"
								min="10"
								step="50"
								class="w-20 rounded-sm bg-gray-700 px-1 py-0.5 text-xs text-white"
								value={valueOf(row, version)}
								on:change={(/** @type {any} */ e) => {
									const v = parseInt(e.target.value);
									if (Number.isFinite(v) && v >= 10) row.set?.(v);
								}} />
						{:else if row.kind === 'choice'}
							<ThemedSelect
								id={'vr-set-' + row.id}
								items={(row.options ?? []).map((o) => ({ value: o.value, name: o.label }))}
								value={valueOf(row, version)}
								onchange={(v) => row.set?.(v)} />
						{:else if row.kind === 'range'}
							<ThemedSelect id={'vr-set-' + row.id} items={rangeItems(row)} value={valueOf(row, version)} onchange={(v) => row.set?.(Number(v))} />
						{:else}
							<button id={'vr-set-' + row.id} class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500" on:click={() => row.run?.()}
								>{row.label}</button>
						{/if}
					</svelte:fragment>
					{row.note ?? ''}{#if row.id === 'passthrough' && arSupport === false} — not supported on this device{/if}{#if row.kind === 'choice' || row.kind === 'range'}<span class="vr-now"> · now {nowText(row, version)}</span>{/if}
				</SettingRow>
			{/each}
			{#if page.id === 'controls'}
				<!-- plan 55: the VR buttons, remappable; LOCAL — each person maps their own controllers -->
				<div class="vr-remap" data-tour="settings-vr-controls">
					<div class="vr-remap-head">
						<span>Action</span><span>Hand</span><span>Button</span><span class="vr-remap-doc">What it does</span>
					</div>
					{#each VR_ACTIONS as a (a.id)}
						{@const b = $vrBindings[a.id]}
						<div class="vr-remap-row" class:vr-remap-conflict={pending?.id === a.id || pending?.other === a.id} data-action={a.id}>
							<span class="vr-remap-name">{a.label}</span>
							{#if a.kind === 'locked'}
								<span class="vr-remap-locked">Both</span>
								<span class="vr-remap-locked">{controlName('both', b.control)}</span>
							{:else}
								<!-- re-keyed on the binding: a refused pick (a conflict you Cancel) snaps back to the truth -->
								{#key b.hand + '|' + b.control + '|' + (pending ? pending.id : '')}
									<ThemedSelect id={'vr-bind-' + a.id + '-hand'} items={HANDS} value={b.hand} onchange={(v) => rebind(a.id, { hand: v })} />
									{#if a.kind === 'button'}
										<ThemedSelect id={'vr-bind-' + a.id + '-control'} items={controlItems(a.kind, b.hand)} value={b.control} onchange={(v) => rebind(a.id, { control: v })} />
									{:else}
										<span class="vr-remap-locked">{controlName(b.hand, b.control)}</span>
									{/if}
								{/key}
							{/if}
							<span class="vr-remap-doc">{a.doc}</span>
						</div>
						{#if pending?.id === a.id}
							<div class="vr-remap-warn" role="alert" id="vr-bind-conflict">
								⚠ {controlName(pending.want.hand, pending.want.control)} is already {labelOf(pending.other)}.
								<button id="vr-bind-swap" class="vr-remap-btn" on:click={swapPending}>Swap them</button>
								<button id="vr-bind-cancel" class="vr-remap-btn" on:click={() => (pending = null)}>Cancel</button>
							</div>
						{/if}
					{/each}
					<div class="vr-remap-foot">
						<button
							id="vr-bind-reset"
							class="rounded-sm bg-gray-600 px-2 py-1 text-xs text-white hover:bg-gray-500"
							on:click={() => {
								resetBindings();
								pending = null;
								showToast('VR buttons reset to the defaults');
							}}>Reset buttons</button>
						<span class="vr-now">Local to this device — your peers keep their own buttons. The headset has the same table: Settings ▸ Controls ▸ Remap buttons.</span>
					</div>
				</div>
			{/if}
		{/if}
	{/each}
</div>

<style>
	.vr-sub {
		margin: 10px 0 4px;
		font-size: 0.7rem;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--muted, #9ca3af);
	}
	.vr-now {
		color: var(--muted, #9ca3af);
	}
	.vr-remap {
		margin: 4px 0 8px;
		border: 1px solid var(--border, #4b5563);
		border-radius: 8px;
		padding: 6px;
		font-size: 0.75rem;
		color: var(--text, #e5e7eb);
	}
	.vr-remap-head,
	.vr-remap-row {
		display: grid;
		grid-template-columns: minmax(96px, 130px) minmax(72px, 96px) minmax(96px, 130px) minmax(0, 1fr);
		gap: 6px;
		align-items: center;
		padding: 3px 2px;
	}
	.vr-remap-head {
		color: var(--muted, #9ca3af);
		font-weight: 600;
	}
	.vr-remap-row + .vr-remap-row {
		border-top: 1px solid var(--border, #4b5563);
	}
	.vr-remap-conflict {
		outline: 1px solid var(--accent, #f97316);
		border-radius: 4px;
	}
	.vr-remap-locked {
		color: var(--muted, #9ca3af);
	}
	.vr-remap-doc {
		color: var(--text-2, #cbd5e1);
	}
	.vr-remap-warn {
		margin: 2px 0 4px;
		padding: 4px 6px;
		border-radius: 4px;
		border: 1px solid var(--accent, #f97316);
		color: var(--text, #e5e7eb);
		background: var(--surface-2, #374151);
	}
	.vr-remap-btn {
		margin-left: 6px;
		padding: 1px 8px;
		border-radius: 4px;
		border: 1px solid var(--border, #4b5563);
		background: var(--field, #1f2937);
		color: var(--text, #e5e7eb);
	}
	.vr-remap-btn:hover {
		background: var(--hover, #4b5563);
	}
	.vr-remap-foot {
		display: flex;
		gap: 8px;
		align-items: center;
		margin-top: 6px;
	}
	@media (max-width: 640px) {
		.vr-remap-head {
			display: none;
		}
		.vr-remap-row {
			grid-template-columns: 1fr 1fr;
		}
		.vr-remap-doc {
			grid-column: 1 / -1;
		}
	}
</style>
