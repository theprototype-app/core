<script>
	// 106 S1 — Configure Scene ▸ Lights ▸ Shadow quality. SCENE data (it rides the environment state: saved, sent
	// to everyone, undone like the sky), so the row says the scene, not this device. Every device draws it capped
	// by its tier (shadowLevelCore's table): a phone or a headset draws less and says so here, and nobody's device
	// rewrites the scene for the others. The device's own cap on shadow map size is Quality ▸ Shadow detail.
	// Lazy: Inspector imports this file only when the section renders, so boot carries none of it.
	import PropRow from '../../ui/PropRow.svelte';
	import Segmented from '../../ui/Segmented.svelte';
	// the level reader through environment's re-export: importing shadowLevelCore here would split it out of
	// environment's boot chunk
	import { environment, setSceneShadowLevel, shadowTier, shadowLevelOf, drawnShadowLevel } from '$lib/environment';
	import { cappedNote } from '$lib/shadows/shadowLevelParams.js';
	import { cinematicState } from '$lib/cinematic/cinematicStore.js';
	import { shadowQuality } from '$lib/lightParams';
	import { globalRenderer } from '../../../stores/sceneStore';

	const LEVELS = [
		{ value: 'off', label: 'Off', title: 'No shadows in this scene' },
		{ value: 'basic', label: 'Basic', title: 'One shadow map per light that casts: the look every scene has had so far' },
		{ value: 'soft', label: 'Soft', title: 'Softer shadow edges, plus contact shadows where objects touch on devices that can afford them' },
		{ value: 'far', label: 'Far', title: "Soft, and the sky's sun casts sharp shadows near you and shadows out to 300 m (none past that)" }
	];

	const asked = $derived(shadowLevelOf($environment.shadowLevel));
	const tier = $derived(shadowTier($globalRenderer));
	const drawn = $derived(drawnShadowLevel(asked, tier));
	const capped = $derived(cappedNote(asked, drawn));
	const cinematic = $derived($cinematicState.mode !== 'off' && drawn === 'far');
	const deviceOff = $derived($shadowQuality === 'off' && asked !== 'off');
</script>

<PropRow label="Shadow quality" valueBox={false} id="scene-shadow-level-row">
	{#snippet control()}
		<Segmented id="scene-shadow-level" label="Shadow quality" full options={LEVELS} value={asked} onchange={(v) => setSceneShadowLevel(v)} />
	{/snippet}
</PropRow>
{#if deviceOff}
	<p id="scene-shadow-level-note" class="text-[length:var(--fs-badge)] text-text-muted">This device draws no shadows: Quality ▸ Shadow detail is Off.</p>
{:else if capped}
	<p id="scene-shadow-level-note" class="text-[length:var(--fs-badge)] text-text-muted">{capped}. Everyone else sees the scene as set.</p>
{:else if cinematic}
	<p id="scene-shadow-level-note" class="text-[length:var(--fs-badge)] text-text-muted">The Cinematic view draws Soft.</p>
{/if}
<p class="text-[length:var(--fs-badge)] text-text-muted">For everyone in the scene, saved with it.</p>
