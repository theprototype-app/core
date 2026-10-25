<script>
	// 77 L1 — a camera's FILM LOOK, edited where the camera is: depth of field (focus target,
	// tap-to-focus, distance, aperture, pull time) and the letterbox matte.
	//
	// Two homes, both already shared: the LENS is camera data (`userData.camera`, written through
	// setCameraFor — props undo + objectParameters, the FOV row's path), and DOF / letterbox are
	// entries in this camera's OWN look document (scenePost keyed by the camera's uuid), so they
	// render only while someone looks through this camera — switching shots switches them.
	import Section from '../../ui/Section.svelte';
	import SliderRow from '../../ui/SliderRow.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import InsToggle from './InsToggle.svelte';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { cameraSpec, isCameraObject, setCameraFor } from '$lib/cameraObjects';
	import { postStacks, postStackFor, addPostEffect, removePostEffect, setPostEffectParams, beginLookGesture, endLookGesture } from '$lib/scenePost';
	import { LENS_DEFAULTS, LETTERBOX_PRESETS, lensOf } from '$lib/filmLookCore';
	import { focusPickArm, armFocusPick, cancelFocusPick } from '$lib/focusPick';

	/** @type {{object: any}} */
	let { object } = $props();

	const uuid = $derived(object?.uuid ?? '');
	// THREE trees are not reactive: derive from the POKED stores (the repo's unused-param idiom)
	/** @param {any} _poke @param {any} o */
	const lensFor = (_poke, o) => lensOf(cameraSpec(o));
	const lens = $derived(lensFor($objectsGroup, object));
	/** @param {any} _poke @param {string} key */
	const lookOf = (_poke, key) => postStackFor(key).effects;
	const look = $derived(lookOf($postStacks, uuid));
	const dofEntries = $derived(look.filter((e) => e.kind === 'dof'));
	const matte = $derived(look.find((e) => e.kind === 'letterbox') ?? null);
	const matteAspect = $derived(matte && matte.enabled ? Number(matte.params?.aspect) || 0 : 0);

	/** @param {any} _poke */
	const targetsOf = (_poke) => {
		/** @type {{value: string, name: string}[]} */
		const items = [{ value: '', name: 'Nothing — use the distance' }];
		for (const child of $objectsGroup?.children ?? []) {
			if (isCameraObject(child)) continue;
			items.push({ value: child.uuid, name: child.name || child.type || 'Object' });
		}
		// a tapped target may be a part inside a model: keep it listed so the select shows it
		if (lens.focusTarget && !items.some((i) => i.value === lens.focusTarget)) {
			const part = $objectsGroup?.getObjectByProperty?.('uuid', lens.focusTarget);
			items.push({ value: lens.focusTarget, name: part ? (part.name || part.type) + ' (tapped)' : 'Missing object' });
		}
		return items;
	};
	const targets = $derived(targetsOf($objectsGroup));
	const picking = $derived($focusPickArm === uuid);

	/** @param {boolean} on */
	function setDof(on) {
		if (on && !dofEntries.length) addPostEffect('dof', undefined, uuid);
		if (!on) for (const entry of dofEntries) removePostEffect(entry.id, uuid);
	}

	/** @param {number} aspect */
	function setMatte(aspect) {
		if (!aspect) {
			if (matte) removePostEffect(matte.id, uuid);
			return;
		}
		if (matte) setPostEffectParams(matte.id, { aspect }, uuid);
		else {
			// add + set the aspect as ONE undo step and ONE message
			beginLookGesture(uuid);
			const id = addPostEffect('letterbox', undefined, uuid);
			setPostEffectParams(id, { aspect }, uuid);
			endLookGesture();
		}
	}

	/** @param {string} target */
	function setTarget(target) {
		setCameraFor(uuid, { focusTarget: target, focusPoint: null });
	}

	const near = (/** @type {number} */ a, /** @type {number} */ b) => Math.abs(a - b) < 0.005;
</script>

<Section variant="panel" label="Film look" badge="Shared" aliases={['depth of field', 'focus', 'letterbox', 'aperture', 'bokeh']}>
	<div id="film-look" class="flex flex-col gap-1">
		<InsToggle id="film-dof" checked={dofEntries.length > 0} onchange={(e) => setDof(e.currentTarget.checked)}
			>Depth of field</InsToggle
		>
		{#if dofEntries.length}
			<div class="ui-row items-center gap-2">
				<span class="w-20 shrink-0 text-xs text-text-muted" id="film-focus-label">Focus on</span>
				<div class="min-w-0 flex-1">
					<ThemedSelect id="film-focus-target" items={targets} value={lens.focusTarget} onchange={(v) => setTarget(v)} />
				</div>
			</div>
			<div class="ui-row flex-wrap items-center gap-2">
				<button
					id="film-focus-pick"
					class={'ui-chip ' + (picking ? 'ins-chip-on' : '')}
					aria-pressed={picking}
					title="Click or tap the picture: that point stays sharp, even as it moves (Alt = just the distance)"
					onclick={() => (picking ? cancelFocusPick() : armFocusPick(uuid))}>{picking ? 'Click the picture… (Esc)' : 'Tap to focus'}</button
				>
				{#if lens.focusTarget}
					<span id="film-focus-following" class="text-[length:var(--fs-badge)] text-text-muted">Following a target</span>
				{/if}
			</div>
			{#if !lens.focusTarget}
				<SliderRow
					id="film-focus"
					label="Distance (m)"
					min={0.1}
					max={100}
					step={0.1}
					decimals={1}
					value={Number.isFinite(lens.focus) ? lens.focus : LENS_DEFAULTS.focus}
					resetValue={LENS_DEFAULTS.focus}
					onchange={(v) => setCameraFor(uuid, { focus: v })}
				/>
			{/if}
			<SliderRow
				id="film-aperture"
				label="Aperture (f/)"
				min={0.7}
				max={22}
				step={0.1}
				decimals={1}
				value={Number.isFinite(lens.aperture) ? lens.aperture : LENS_DEFAULTS.aperture}
				resetValue={LENS_DEFAULTS.aperture}
				onchange={(v) => setCameraFor(uuid, { aperture: v })}
			/>
			<SliderRow
				id="film-focus-pull"
				label="Pull time (s)"
				min={0}
				max={5}
				step={0.1}
				decimals={1}
				value={lens.focusPull}
				resetValue={0}
				onchange={(v) => setCameraFor(uuid, { focusPull: v })}
			/>
		{/if}
		<div class="ui-row flex-wrap items-center gap-1" role="group" aria-labelledby="film-matte-label">
			<span class="w-20 shrink-0 text-xs text-text-muted" id="film-matte-label">Letterbox</span>
			{#each LETTERBOX_PRESETS as preset}
				<button
					class={'ui-chip ' + (near(matteAspect, preset.value) ? 'ins-chip-on' : '')}
					data-matte={preset.value}
					aria-pressed={near(matteAspect, preset.value)}
					onclick={() => setMatte(preset.value)}>{preset.label}</button
				>
			{/each}
		</div>
		<p class="text-[length:var(--fs-badge)] italic text-text-muted">
			Part of this camera’s look: it shows while anyone looks through this camera, and switching shots switches it. Not drawn in VR.
		</p>
	</div>
</Section>
