<script>
	// 103 H7 — Settings ▸ Scene ▸ Gizmo: which transform gizmo this device draws (Auto, or one of the
	// four forced), how big its handles are, and per style which handle kinds show. LOCAL prefs
	// ($lib/gizmo/gizmoPrefs): a peer never sees which style anyone uses, and a drag does the same in all.
	import Section from '../../ui/Section.svelte';
	import SettingRow from '../../ui/SettingRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import { gizmoStyle, gizmoSize, gizmoHide, activeGizmoStyle, setKindShown, STYLE_KINDS } from '$lib/gizmo/gizmoPrefs';

	const STYLES = [
		{ value: 'auto', label: 'Auto', title: 'All in one with a mouse, the touch puck on a touch screen (default)' },
		{ value: 'A', label: 'Separate', title: 'One tool at a time: Move, Rotate or Resize (the classic gizmo)' },
		{ value: 'B', label: 'All in one', title: 'Arrows, plane squares, rings, resize cubes and a centre knob together' },
		{ value: 'C', label: 'Touch puck', title: 'A ground disc to slide, a lift arrow, a turn ring and a resize knob; tap the disc for per-axis handles' },
		{ value: 'D', label: 'Box', title: 'A box at the object’s size: corners resize, face arrows push one side, an arc turns it' }
	];
	const SIZES = [
		{ value: 'S', label: 'Small' },
		{ value: 'M', label: 'Medium' },
		{ value: 'L', label: 'Large' }
	];
	/** @type {Record<string, string>} */
	const KIND_LABEL = {
		arrows: 'Move arrows',
		planes: 'Plane squares',
		rings: 'Turn rings',
		cubes: 'Resize cubes',
		knob: 'Centre knob',
		disc: 'Ground disc',
		lift: 'Lift arrow',
		ring: 'Turn ring',
		corners: 'Corner knobs',
		faces: 'Face arrows',
		arc: 'Turn arc'
	};
	/** the style whose handles "show only" lists: the one in force (Auto resolved), A has none */
	const listed = $derived($activeGizmoStyle);
	const kinds = $derived(/** @type {Record<string, string[]>} */ (STYLE_KINDS)[listed] ?? []);
	const hidden = $derived(new Set($gizmoHide[listed] ?? []));
	const NAMES = { A: 'Separate tools', B: 'All in one', C: 'Touch puck', D: 'Box' };
</script>

<Section variant="card" label="Gizmo" badge="This device">
	<SettingRow id="row-gizmo-style" label="Gizmo style" description="The handles you drag to move, turn and resize. Auto picks all in one with a mouse and the touch puck on a touch screen. Repeat 1, 2 or 3 (or the toolbar button) to step that tool's handles, all in one, hidden." wide>
		<ThemedSelect id="gizmo-style" items={STYLES.map((o) => ({ value: o.value, name: o.label, title: o.title }))} bind:value={$gizmoStyle} />
	</SettingRow>
	<SettingRow id="row-gizmo-size" label="Handle size" description="How big the gizmo draws on screen.">
		<Segmented id="gizmo-size" label="Handle size" options={SIZES} value={$gizmoSize} onchange={(v) => gizmoSize.set(String(v))} />
	</SettingRow>
	{#if kinds.length}
		<SettingRow id="row-gizmo-show" label={'Show (' + (/** @type {any} */ (NAMES)[listed] ?? listed) + ')'} description="Switch off the handle kinds you never use. The toolbar buttons still filter by tool." wide>
			<div class="gizmo-kinds" role="group" aria-label="Handles to show">
				{#each kinds as kind (kind)}
					<label class="gizmo-kind">
						<input
							type="checkbox"
							class="tp-check"
							data-gizmo-kind={kind}
							checked={!hidden.has(kind)}
							onchange={(e) => setKindShown(listed, kind, e.currentTarget.checked)}
						/>
						<span>{KIND_LABEL[kind] ?? kind}</span>
					</label>
				{/each}
			</div>
		</SettingRow>
	{/if}
</Section>

<style>
	.gizmo-kinds {
		display: flex;
		flex-wrap: wrap;
		gap: 6px 14px;
	}
	.gizmo-kind {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		min-height: 28px;
		font-size: var(--fs-body, 13px);
		color: var(--text);
		cursor: pointer;
	}
</style>
