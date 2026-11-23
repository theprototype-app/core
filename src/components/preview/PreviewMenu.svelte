<script>
	// 103 H11 — THE PREVIEW MENU's body: the one place for HOW THIS DEVICE DRAWS THE SCENE. Shared by the
	// desktop pill's dropdown (all groups) and the phone drawer (no Judge for). Groups, in order:
	//   Cinematic view   Off / the quality levels (only where the view is offered; 100 C1's own rules)
	//   Draw as          viewMode's three + the Draw as modes ($lib/drawAs)
	//   Quality          the device quality preset (Auto / High / Medium / Low, 42 I12)
	//   Judge for        This device / Phone / Quest / PC, independent toggles ($lib/judgeFor) — desktop only
	// then "Statistics…" and "Scene look settings…" and the footer that draws the line with Configure scene.
	// Nothing here edits the scene: the scene's look (environment, post stack, fog, tone mapping) is Configure
	// scene's, and "Scene look settings…" goes there. Switches and toggles leave the menu open; the two "…"
	// rows close it.
	import Icon from '../ui/Icon.svelte';
	import Segmented from '../ui/Segmented.svelte';
	import { viewMode, objectsGroup } from '../../stores/sceneStore';
	import { openSceneSection } from '../../stores/appStore';
	import { cinematicState, cinematicPrefs, setCinematic, setCinematicQuality } from '$lib/cinematic/cinematicState.js';
	import { QUALITY, QUALITY_HINT, QUALITY_STEPS, HIGH_MAX_PIXELS } from '$lib/cinematic/cinematicCore.js';
	import { drawAs, DRAW_ROWS, DRAW_AS_LABEL, DRAW_AS_HINT, drawRowOf, pickDrawRow } from '$lib/drawAs.js';
	import { qualityPreset, gameQualityState } from '$lib/qualityGovernor';
	import { scenePost, sceneProvidesAo } from '$lib/scenePost';
	import { sceneCost, verdictFor, openBudget, setBudgetTarget } from '$lib/budgetMeter';
	import { judgeFor, toggleJudge, here } from '$lib/judgeFor.js';
	import { JUDGE_IDS, JUDGE_LABEL, TARGET_ICON, targetOf } from '$lib/judgeForCore.js';

	/** judge = the Judge for group (desktop); cine = the Cinematic view group (where it is offered) */
	let { judge = true, cine = false, onclose = () => {} } = $props();

	const QUALITY_PRESETS = [
		{ value: 'auto', label: 'Auto', title: 'Full quality, lowered on its own when the scene is heavy' },
		{ value: 'high', label: 'High', title: 'Everything on: shadows, full resolution, effects' },
		{ value: 'medium', label: 'Medium', title: 'Shadows off, 72 % resolution' },
		{ value: 'low', label: 'Low', title: 'Shadows, ambient occlusion and the scene look off, 50 % resolution' }
	];

	// ---- Cinematic view ----
	const cineOn = $derived($cinematicState.mode === 'on' || $cinematicState.mode === 'entering');
	const cineBusy = $derived($cinematicState.mode === 'entering' || $cinematicState.mode === 'leaving');
	const cineOff = $derived(!!$cinematicState.disabled && $cinematicState.mode === 'off');
	let pixels = $state(0);
	$effect(() => {
		const r = document.getElementById('viewport')?.getBoundingClientRect();
		pixels = r ? Math.round(r.width * devicePixelRatio) * Math.round(r.height * devicePixelRatio) : 0;
	});
	/** @param {string} q */
	async function pickCine(q) {
		if (q === 'off') return void setCinematic(false);
		await setCinematicQuality(q);
		if (!cineOn) void setCinematic(true);
	}

	// ---- Draw as ----
	const row = $derived(drawRowOf($viewMode, $drawAs));
	const aoTaken = $derived(sceneProvidesAo($scenePost));
	const skinned = $derived.by(() => {
		let found = false;
		/** @type {any} */ ($objectsGroup)?.traverse?.((/** @type {any} */ o) => {
			if (o.isSkinnedMesh) found = true;
		});
		return found;
	});
	/** @param {string} r @returns {string} why the row is off ('' = it is not) */
	function rowOff(r) {
		if (cineOn) return 'The Cinematic view draws the normal look: turn it off to pick another';
		if (r === 'shaded-ao' && aoTaken) return 'This scene sets its own ambient occlusion, so your personal setting does not apply';
		if (r === 'weights' && !skinned) return 'Nothing in this scene is skinned: weights need a rigged model';
		return '';
	}

	// ---- Judge for ----
	const hereT = here();
	/** @param {any} id */
	const pctOf = (id) => verdictFor($sceneCost, targetOf(id, hereT));

	function stats() {
		onclose();
		openBudget();
	}
	function look() {
		onclose();
		openSceneSection('Scene look');
	}
</script>

<div class="pm" role="group" aria-label="Preview">
	{#if cine}
		<p class="pm-g" id="pm-g-cine">Cinematic view</p>
		<div class="pm-rows" role="radiogroup" aria-labelledby="pm-g-cine" id="preview-cinematic">
			{#each ['off', ...QUALITY_STEPS] as q (q)}
				{@const highNo = q === 'high' && pixels > HIGH_MAX_PIXELS}
				{@const checked = q === 'off' ? !cineOn : cineOn && $cinematicPrefs.quality === q}
				<button
					type="button"
					role="radio"
					id={'preview-cine-' + q}
					class="pm-row"
					aria-checked={checked}
					disabled={cineBusy || cineOff || highNo}
					title={cineOff ? 'Cinematic view is off for this session: ' + $cinematicState.disabled : highNo ? 'Not at this window size (more than 2560 x 1440 pixels)' : q === 'off' ? 'The standard view' : QUALITY_HINT[/** @type {'basic'} */ (q)]}
					onclick={() => pickCine(q)}
				>
					<span class="pm-mark" aria-hidden="true"></span>{q === 'off' ? 'Off' : QUALITY[/** @type {'basic'} */ (q)].label}
				</button>
			{/each}
		</div>
		{#if cineOn && $cinematicState.dropped > 0}
			<p class="pm-note" id="preview-cine-dropped">Lowered to {QUALITY[$cinematicState.quality].label} to keep it smooth</p>
		{/if}
	{/if}

	<p class="pm-g" id="pm-g-draw">Draw as</p>
	<div class="pm-rows" role="radiogroup" aria-labelledby="pm-g-draw" id="preview-draw">
		{#each DRAW_ROWS as r (r)}
			{@const why = rowOff(r)}
			<button type="button" role="radio" id={'preview-draw-' + r} class="pm-row" aria-checked={row === r} aria-disabled={!!why} data-why={why || undefined} title={why || DRAW_AS_HINT[r]} onclick={() => !why && pickDrawRow(r)}>
				<span class="pm-mark" aria-hidden="true"></span>{DRAW_AS_LABEL[r]}
			</button>
		{/each}
	</div>

	<p class="pm-g" id="pm-g-quality">Quality</p>
	<Segmented id="preview-quality" label="Quality" full options={QUALITY_PRESETS} value={$qualityPreset} onchange={(/** @type {any} */ v) => qualityPreset.set(v)} />
	{#if $gameQualityState.level !== null}
		<p class="pm-note">The game being played holds its own Quality setting ({$gameQualityState.preset}) until you leave it.</p>
	{/if}

	{#if judge}
		<p class="pm-g" id="pm-g-judge">Judge for</p>
		<div class="pm-rows" role="group" aria-labelledby="pm-g-judge" id="preview-judge">
			{#each JUDGE_IDS as id (id)}
				{@const v = pctOf(id)}
				{@const on = $judgeFor.includes(id)}
				<button type="button" role="switch" id={'preview-judge-' + id} class="pm-row" aria-checked={on} title={on ? `Stop showing ${JUDGE_LABEL[id]} in the pill` : `Show ${JUDGE_LABEL[id]}'s budget in the pill`} onclick={() => toggleJudge(id)}>
					<span class="pm-check" aria-hidden="true">{#if on}<Icon name="check" size={16} />{/if}</span>
					<Icon name={TARGET_ICON[targetOf(id, hereT)]} size={16} aria-hidden="true" />
					<span class="pm-grow">{JUDGE_LABEL[id]}</span>
					<span class="pm-pct" data-tier={v.tier}>{$sceneCost ? v.percent + '%' : ''}</span>
				</button>
			{/each}
		</div>
	{/if}

	<div class="pm-sep"></div>
	{#if judge}
		<button type="button" class="pm-row pm-link" id="preview-stats" onclick={stats}><Icon name="gauge" size={16} aria-hidden="true" /><span>Statistics…</span></button>
	{/if}
	<button type="button" class="pm-row pm-link" id="preview-scene-look" onclick={look}><Icon name="sliders-horizontal" size={16} aria-hidden="true" /><span>Scene look settings…</span></button>
	<p class="pm-foot" id="preview-foot">Preview changes how this device draws the scene: never saved, never shared. Configure scene is what the scene is: saved, and everyone sees it.</p>
</div>

<style>
	.pm {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--fs-desc);
		color: var(--text);
	}
	.pm-g {
		margin: 8px 8px 2px;
		font-size: var(--fs-badge);
		font-weight: 600;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--text-muted);
	}
	.pm-g:first-child {
		margin-top: 2px;
	}
	.pm-rows {
		display: flex;
		flex-direction: column;
	}
	.pm-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 30px;
		padding: 0 8px;
		border-radius: var(--radius-control, 6px);
		color: inherit;
		text-align: left;
		width: 100%;
	}
	.pm-row:hover:not(:disabled):not([aria-disabled='true']) {
		background: var(--surface-hover);
	}
	.pm-row:focus-visible {
		outline: var(--focus-ring-width) solid var(--focus-ring);
		outline-offset: calc(-1 * var(--focus-ring-width));
	}
	.pm-row:disabled,
	.pm-row[aria-disabled='true'] {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.pm-mark {
		width: 8px;
		height: 8px;
		border-radius: 9999px;
		border: 1.5px solid var(--text-muted);
		flex: none;
	}
	.pm-row[aria-checked='true'] .pm-mark {
		background: var(--accent);
		border-color: var(--accent);
	}
	.pm-row[aria-checked='true'] {
		font-weight: 600;
	}
	.pm-check {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 16px;
		height: 16px;
		border-radius: 4px;
		border: 1.5px solid var(--text-muted);
		flex: none;
	}
	.pm-row[aria-checked='true'] .pm-check {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}
	.pm-grow {
		flex: 1;
	}
	.pm-pct {
		font-variant-numeric: tabular-nums;
		color: var(--text-2);
	}
	.pm-pct[data-tier='amber'] {
		color: var(--ink-warn);
	}
	.pm-pct[data-tier='red'] {
		color: var(--ink-bad);
	}
	.pm-note {
		margin: 2px 8px;
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
	.pm-sep {
		height: 1px;
		margin: 6px 0;
		background: var(--border);
	}
	.pm-link {
		color: var(--text);
	}
	.pm-foot {
		margin: 6px 8px 2px;
		padding-top: 6px;
		border-top: 1px solid var(--border);
		font-size: var(--fs-badge);
		color: var(--text-muted);
	}
</style>
