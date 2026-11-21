<script>
	// 102 M3: Inspector ▸ Decal — the image projected onto the surface under it, its size and
	// depth (the projector box = the object's scale, so the gizmo's scale handle sizes it too),
	// opacity, tint, roughness and the wrap angle. Writes go through decalEdit (replicated, one
	// undo step per scrub); every peer rebuilds the surface from the record.
	import Section from '../ui/Section.svelte';
	import SliderRow from '../ui/SliderRow.svelte';
	import DragRow from '../ui/DragRow.svelte';
	import ShaderTexturePicker from '../editors/nodes/ShaderTexturePicker.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { normalizeDecal, DECAL_DEFAULTS } from '$lib/decalCore.js';
	import { setDecalFor, setDecalSize, endDecalSizeScrub } from '$lib/decalEdit.js';
	import { dismissTip, tipShown, TIP_DECAL } from '$lib/tips.js';
	import { itemByHash } from '$lib/explorer';

	/** @type {{object: any}} */
	let { object } = $props();
	const r = $derived.by(() => {
		$objectsGroup; // a remote edit or an undo pokes this store
		return normalizeDecal(object?.userData?.decal);
	});
	const size = $derived.by(() => {
		$objectsGroup;
		return object?.scale ? object.scale.toArray() : [0.5, 0.5, 0.25];
	});
	const target = $derived.by(() => {
		$objectsGroup;
		const p = object?.parent;
		return p && p !== $objectsGroup ? p.name || 'an object' : null;
	});
	const showTip = tipShown(TIP_DECAL);

	/** @param {any} patch */
	function set(patch) {
		setDecalFor(object.uuid, patch);
	}
	/** @param {string} hash */
	function pickImage(hash) {
		const name = hash ? String(/** @type {any} */ (itemByHash(hash))?.name ?? '') : '';
		set({ image: hash || '', imageName: name });
		if (hash) dismissTip(TIP_DECAL);
	}

	// a size scrub is ONE undo step: live moves while dragging, the entry at the end
	/** @type {number[] | null} */
	let scrubFrom = null;
	/** @param {number} axis @param {number} v */
	function setSize(axis, v) {
		const next = [...size];
		next[axis] = v;
		setDecalSize(object.uuid, next, { record: scrubFrom === null });
	}
	function scrubStart() {
		scrubFrom = object.scale.toArray();
	}
	function scrubEnd() {
		if (scrubFrom) endDecalSizeScrub(object.uuid, scrubFrom);
		scrubFrom = null;
	}

	const keywords = 'decal sticker image projected projection sign arrow mark dirt crack graffiti logo label stamp surface wrap';
</script>

<div data-keywords={keywords} class="contents">
	<Section variant="panel" label="Decal">
		<div data-tour="decal" class="contents">
			{#if $showTip}
				<div id="decal-first-use" class="flex items-start gap-2 rounded-md border border-border bg-surface-2 p-2 text-xs text-text-2" role="note">
					<p class="grow">
						Pick an image below (or drag one from the Library). Move, turn and scale the decal with the gizmo: it wraps the surface inside its box.
						Depth limits how far it reaches.
					</p>
					<button class="ui-chip text-text-2" aria-label="Close the tip" title="Close the tip" onclick={() => dismissTip(TIP_DECAL)}>✕</button>
				</div>
			{/if}
			<div class="flex items-center gap-2" title="The image projected onto the surface: import a file or drag one from the Library">
				<span class="w-20 shrink-0 text-xs text-text-muted">Image</span>
				<div id="decal-image" class="min-w-0 grow">
					<ShaderTexturePicker hash={r.image} onpick={pickImage} />
				</div>
			</div>
			{#if target}
				<p id="decal-target" class="text-[length:var(--fs-badge)] text-text-faint">On {target}: it moves with it.</p>
			{/if}
			<DragRow id="decal-width" label="Width" title="How wide the decal is" value={size[0]} min={0.01} max={50} step={0.005} decimals={3} unit="length" onscrubstart={scrubStart} onscrubend={scrubEnd} onchange={(v) => setSize(0, v)} />
			<DragRow id="decal-height" label="Height" title="How tall the decal is" value={size[1]} min={0.01} max={50} step={0.005} decimals={3} unit="length" onscrubstart={scrubStart} onscrubend={scrubEnd} onchange={(v) => setSize(1, v)} />
			<DragRow id="decal-depth" label="Depth" title="How far into and out of the surface it reaches: a small depth keeps it off the faces behind" value={size[2]} min={0.01} max={50} step={0.005} decimals={3} unit="length" onscrubstart={scrubStart} onscrubend={scrubEnd} onchange={(v) => setSize(2, v)} />
			<div class="contents" title="How solid the decal looks (0 = gone)">
				<SliderRow id="decal-opacity" label="Opacity" min={0} max={1} step={0.01} value={r.opacity} onchange={(v) => set({ opacity: v })} />
			</div>
			<div class="contents" title="Shiny (0) to matte (1)">
				<SliderRow id="decal-roughness" label="Roughness" min={0} max={1} step={0.01} value={r.roughness} onchange={(v) => set({ roughness: v })} />
			</div>
			<div class="contents" title="Faces turned further than this from the decal are not covered (stops it smearing round corners)">
				<SliderRow id="decal-angle" label="Wrap angle" min={5} max={89} step={1} decimals={0} value={r.angle} onchange={(v) => set({ angle: v })} />
			</div>
			<div class="flex items-center gap-2" title="Multiplies the image's colours (white = as it is)">
				<span class="w-20 shrink-0 text-xs text-text-muted">Tint</span>
				<input
					id="decal-tint"
					type="color"
					class="h-6 w-8 cursor-pointer rounded-sm border border-border-strong bg-transparent"
					aria-label="Tint colour"
					value={r.tint}
					onchange={(/** @type {any} */ e) => set({ tint: e.currentTarget.value })}
				/>
				{#if r.tint !== DECAL_DEFAULTS.tint}
					<button id="decal-tint-reset" class="ui-chip text-text-2" title="Back to white (the image as it is)" aria-label="Reset the tint" onclick={() => set({ tint: DECAL_DEFAULTS.tint })}>✕</button>
				{/if}
			</div>
		</div>
	</Section>
</div>
