<script>
	// 57 — Inspector ▸ Character, for a rigged model: which rig it is and how much of the VRM 1.0
	// humanoid set it maps (M2), the clips applied to it from elsewhere (remove one here), and the
	// ways in — Apply clip… (M2), Skeleton… (M6, the map editor lives there) and Download… (M9).
	// The VRM's own licence / permissions (M4) and the provenance line (M7) sit at the bottom.
	// Shown only for a model with bones; the humanoid code loads when it is first shown.
	import Section from '../../ui/Section.svelte';
	import UiButton from '../../ui/Button.svelte';
	import { sceneRevision } from '../../../stores/sceneStore';
	import { animatedObjects, vrmExpressionNames, setVrmExpression } from '$lib/animatedImports';
	import { openApplyClip } from '$lib/characterUi.js';
	import { licenceOf, licenceLabel, licenceFlags, normalizeProvenance } from '$lib/provenance';

	/** @type {{ object: any }} */
	let { object } = $props();

	/** @type {any} */
	let rig = $state.raw(null);

	$effect(() => {
		void $sceneRevision;
		void $animatedObjects;
		const uuid = object?.uuid;
		if (!uuid) return;
		let live = true;
		import('$lib/humanoid/humanoidRig.js').then((m) => {
			if (!live) return;
			const s = m.humanoidSummary(uuid);
			rig = s
				? {
						...s,
						label: m.rigLabel(s.rig),
						missingText: s.missing.map(m.boneLabel).join(', '),
						clips: m.configOf(uuid).clips ?? [],
						remove: (/** @type {string} */ n) => m.removeAppliedClip(uuid, n)
					}
				: null;
		});
		return () => (live = false);
	});

	const licence = $derived.by(() => {
		void $sceneRevision;
		return licenceOf(object?.userData);
	});
	const steps = $derived.by(() => {
		void $sceneRevision;
		return normalizeProvenance(object?.userData?.provenance);
	});
	const flags = $derived(licenceFlags(licence));
	// 57 M4: a VRM's own meta + its expressions
	const meta = $derived.by(() => {
		void $sceneRevision;
		return object?.userData?.vrmMeta ?? null;
	});
	const expressions = $derived.by(() => {
		void $sceneRevision;
		void rig;
		return object?.uuid ? vrmExpressionNames(object.uuid) : [];
	});
	let expression = $state('');
	$effect(() => {
		if (expressions.length && !expressions.includes(expression))
			expression = expressions.includes('happy') ? 'happy' : expressions[0];
	});
	const exprWeight = $derived.by(() => {
		void $sceneRevision;
		return Number(object?.userData?.vrmExpressions?.[expression] ?? 0);
	});
	/** @param {string} v */
	const permit = (v) =>
		v === 'true' || v === 'Allow' ? 'yes' : v === 'false' || v === 'Disallow' ? 'no' : v || '—';
</script>

{#if rig}
	<Section variant="panel" label="Character" aliases={['Humanoid', 'Rig', 'Skeleton', 'Retarget']}>
		<div
			id="character-section"
			class="flex flex-col gap-1 text-xs"
			data-rig={rig.rig}
			data-ok={rig.ok ? '1' : '0'}
		>
			<div class="flex items-center gap-2">
				<span class="text-text-muted w-20 shrink-0">Rig</span>
				<b id="character-rig">{rig.label}</b>
				<span class="text-text-muted">· {rig.mapped} of 55 humanoid bones</span>
			</div>
			{#if !rig.ok}
				<p id="character-missing" class="text-ink-warn">
					Not a full humanoid yet — missing {rig.missingText}. Fix the map in Skeleton….
				</p>
			{/if}
			{#if rig.clips.length}
				<span class="text-text-muted pt-1">Applied clips</span>
				{#each rig.clips as c (c.name)}
					<div class="flex items-center gap-2" data-applied-clip={c.name}>
						<span class="min-w-0 flex-1 truncate" title={c.from ? 'From ' + c.from : ''}
							>{c.name}</span
						>
						{#if c.from}<span class="text-text-faint shrink-0">from {c.from}</span>{/if}
						<button
							class="ui-button-quiet shrink-0"
							aria-label={'Remove ' + c.name}
							title="Remove this clip from the character"
							onclick={() => rig.remove(c.name)}>✕</button
						>
					</div>
				{/each}
			{/if}
			<div class="flex flex-wrap gap-1 pt-1">
				<UiButton
					id="character-apply-clip"
					size="sm"
					variant="outline"
					disabled={!rig.ok}
					title="Play a clip from another model or the built-in motions on this character"
					onclick={() => openApplyClip({ targets: [object.uuid] })}>Apply clip…</UiButton
				>
			</div>
			{#if meta}
				<div id="character-vrm" class="flex flex-col gap-0.5 pt-1" data-vrm-version={meta.version}>
					<span class="text-text-muted"
						>VRM {meta.version}{meta.name ? ' · ' + meta.name : ''}{meta.authors.length
							? ' · by ' + meta.authors.join(', ')
							: ''}</span
					>
					<span class="text-text-faint">
						Commercial use: {permit(meta.commercialUsage)} · Redistribution: {meta.allowRedistribution ===
						undefined
							? '—'
							: meta.allowRedistribution
								? 'yes'
								: 'no'}{meta.modification
							? ' · Modification: ' + meta.modification
							: ''}{meta.creditNotation ? ' · Credit: ' + meta.creditNotation : ''}
					</span>
					{#if meta.licenseUrl}<a
							class="text-accent-text"
							href={meta.licenseUrl}
							target="_blank"
							rel="noopener">Licence terms</a
						>{/if}
				</div>
			{/if}
			{#if expressions.length}
				<div id="character-expression" class="flex items-center gap-2 pt-1">
					<span class="text-text-muted w-20 shrink-0">Expression</span>
					<select class="ui-input min-w-0 flex-1" aria-label="Expression" bind:value={expression}>
						{#each expressions as name (name)}<option value={name}>{name}</option>{/each}
					</select>
					<input
						type="range"
						class="accent-accent w-20"
						aria-label="Expression weight"
						min="0"
						max="1"
						step="0.05"
						value={exprWeight}
						oninput={(e) => setVrmExpression(object.uuid, expression, +e.currentTarget.value)}
					/>
				</div>
			{/if}
			{#if steps.length}
				<div
					id="character-provenance"
					class="text-text-muted pt-1"
					data-licence={licence?.id ?? ''}
				>
					<span
						>Licence: <b class={flags.restricted ? 'text-ink-warn' : ''}>{licenceLabel(licence)}</b
						>{licence?.author ? ' · ' + licence.author : ''}</span
					>
					<br /><span class="text-text-faint"
						>{steps[steps.length - 1].tool}{steps[steps.length - 1].model
							? ' · ' + steps[steps.length - 1].model
							: ''} · {steps[steps.length - 1].date.slice(0, 10)}</span
					>
				</div>
			{/if}
		</div>
	</Section>
{/if}
