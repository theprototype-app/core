<script>
	// 78 F4 — the Inspector's PATH section: the path's walk settings, its points' fields (the
	// points picked in the editor, or one chosen here), the commands (reverse / split / join /
	// close), Preview, and the SCRUB GHOST. Every write is a spline-record edit through
	// path/pathActions (replicates as `splineedit`, ONE undo step each); the ghost and the
	// picked points are local.
	import Section from '../../ui/Section.svelte';
	import SliderRow from '../../ui/SliderRow.svelte';
	import UiButton from '../../ui/Button.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import InsToggle from './InsToggle.svelte';
	import Icon from '../../ui/Icon.svelte';
	import { objectsGroup } from '../../../stores/sceneStore';
	import { normalizeSpline } from '$lib/splineTube';
	import { PATH_EASES } from '$lib/path/pathCore.js';
	import { pathOfObject, pathObjectsIn } from '$lib/path/pathRuntime.js';
	import { editingPathUuid, pathScrub, pathSelectedPoints } from '$lib/path/pathState.js';
	import {
		setPathSettings,
		setPathClosed,
		setPathPointFields,
		reversePathObject,
		splitPathObject,
		joinPathObjects,
		editPathObject,
		toastRefusal
	} from '$lib/path/pathActions.js';

	/** @type {{object: any}} */
	let { object } = $props();

	// the record is mutated in place and a THREE tree is not reactive: read through the poke
	const rec = $derived.by(() => {
		$objectsGroup;
		return object?.userData?.spline ? normalizeSpline(object.userData.spline) : null;
	});
	const view = $derived.by(() => {
		rec;
		return object ? pathOfObject(object) : null;
	});
	const editing = $derived($editingPathUuid === object?.uuid);
	/** the point the rows below edit when the editor is closed */
	let chosen = $state(0);
	const targets = $derived(editing && $pathSelectedPoints.length ? $pathSelectedPoints : rec ? [Math.min(chosen, rec.points.length - 1)] : []);
	const first = $derived(rec && targets.length ? rec.points[targets[0]] : null);
	const others = $derived.by(() => {
		$objectsGroup;
		return pathObjectsIn($objectsGroup).filter((o) => o.uuid !== object?.uuid);
	});
	let joinWith = $state('');
	const scrubbing = $derived($pathScrub?.uuid === object?.uuid);
	const MODE_ITEMS = [
		{ value: 'loop', name: 'Loop' },
		{ value: 'pingpong', name: 'Ping-pong' },
		{ value: 'once', name: 'Once' },
		{ value: 'random', name: 'Random next point' }
	];
	const EASE_NAMES = { linear: 'Steady', in: 'Speed up', out: 'Slow down', inout: 'Speed up, then slow down' };

	/** @param {Record<string, any>} patch */
	const setPoints = (patch) => object && targets.length && setPathPointFields(object.uuid, targets, patch);
	/** a field all targets agree on, else undefined @param {string} key */
	function shared(key) {
		if (!rec || !targets.length) return undefined;
		const vals = targets.map((i) => rec.points[i]?.[key]);
		return vals.every((v) => v === vals[0]) ? vals[0] : undefined;
	}
	const mixed = (/** @type {string} */ key) => !!rec && targets.length > 1 && shared(key) === undefined && targets.some((i) => rec.points[i]?.[key] !== undefined);

	function toggleScrub() {
		if (scrubbing) pathScrub.set(null);
		else pathScrub.set({ uuid: object.uuid, t: 0 });
	}
	/** cycle time as m:ss.s @param {number} t */
	const clock = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
</script>

{#if rec?.path}
	<Section variant="panel" label="Path">
		<p id="path-summary" class="px-1 text-[length:var(--fs-badge)] uppercase tracking-wider text-text-faint">
			{rec.points.length} points · {view ? view.length.toFixed(1) : '0'} m · one round {view ? clock(view.period) : '0:00.0'}
		</p>
		<div class="ui-row items-center gap-2">
			<span class="w-24 shrink-0 text-xs text-text-2">Walk</span>
			<ThemedSelect
				id="path-mode"
				class="flex-1"
				value={rec.path.mode}
				items={MODE_ITEMS}
				onchange={(/** @type {any} */ v) => setPathSettings(object.uuid, { mode: v })}
			/>
		</div>
		<SliderRow
			id="path-speed"
			label="Speed (m/s)"
			min={0.1}
			max={10}
			step={0.1}
			decimals={1}
			value={rec.path.speed}
			onchange={(v) => setPathSettings(object.uuid, { speed: v })}
		/>
		{#if rec.path.mode === 'random'}
			<SliderRow
				id="path-seed"
				label="Random seed"
				min={0}
				max={99}
				step={1}
				decimals={0}
				value={rec.path.seed}
				onchange={(v) => setPathSettings(object.uuid, { seed: Math.round(v) })}
			/>
		{/if}
		<InsToggle id="path-smooth" checked={rec.path.smooth} onchange={(e) => setPathSettings(object.uuid, { smooth: e.target.checked })}>
			Smooth curve
		</InsToggle>
		<InsToggle id="path-closed" checked={rec.closed} disabled={rec.points.length < 3} onchange={(e) => setPathClosed(object.uuid, e.target.checked)}>
			Closed loop
		</InsToggle>
		<InsToggle
			id="path-show-in-play"
			checked={rec.path.showInPlay}
			title="Paths are hidden in Play unless this is on"
			onchange={(e) => setPathSettings(object.uuid, { showInPlay: e.target.checked })}
		>
			Show in Play
		</InsToggle>
		<InsToggle
			id="path-preview"
			checked={rec.path.preview}
			title="Walkers on this path move in the editor (they hold still while you edit its points)"
			onchange={(e) => setPathSettings(object.uuid, { preview: e.target.checked })}
		>
			Preview walkers in the editor
		</InsToggle>

		<div class="flex flex-wrap gap-1">
			<UiButton id="path-edit-points" size="sm" variant="outline" onclick={() => editPathObject(object.uuid)}>
				<Icon name="spline" size={16} aria-hidden="true" />
				{editing ? 'Editing points' : 'Edit points'}
			</UiButton>
			<UiButton id="path-reverse" size="sm" variant="outline" title="Walk the other way round" onclick={() => reversePathObject(object.uuid)}>
				<Icon name="arrow-left-right" size={16} aria-hidden="true" />
				Reverse
			</UiButton>
			<UiButton
				id="path-split"
				size="sm"
				variant="outline"
				disabled={targets.length !== 1}
				title="Split at the chosen point (a closed path opens there)"
				onclick={() => toastRefusal(splitPathObject(object.uuid, targets[0]))}
			>
				<Icon name="scissors" size={16} aria-hidden="true" />
				Split at point {targets.length === 1 ? targets[0] + 1 : ''}
			</UiButton>
		</div>
		{#if others.length}
			<div class="ui-row items-center gap-2">
				<span class="w-24 shrink-0 text-xs text-text-2">Join with</span>
				<ThemedSelect
					id="path-join-with"
					class="flex-1"
					clip={false}
					value={joinWith}
					placeholder="Another path"
					items={others.map((o) => ({ value: o.uuid, name: o.name || 'Path' }))}
					onchange={(/** @type {any} */ v) => (joinWith = v)}
				/>
				<UiButton
					id="path-join"
					size="sm"
					variant="outline"
					disabled={!joinWith}
					title="Add that path's points to the end of this one (it is removed)"
					onclick={() => {
						toastRefusal(joinPathObjects(object.uuid, joinWith));
						joinWith = '';
					}}>Join</UiButton
				>
			</div>
		{/if}

		<!-- the point rows: the points picked in the editor, else the one chosen here -->
		<p class="mt-2 text-[length:var(--fs-badge)] uppercase tracking-wide text-text-faint">
			{#if editing && $pathSelectedPoints.length > 1}
				{$pathSelectedPoints.length} points picked
			{:else if editing && $pathSelectedPoints.length === 1}
				Point {$pathSelectedPoints[0] + 1}
			{:else}
				Point
			{/if}
		</p>
		{#if !(editing && $pathSelectedPoints.length)}
			<div class="ui-row items-center gap-2">
				<span class="w-24 shrink-0 text-xs text-text-2">Point</span>
				<ThemedSelect
					id="path-point"
					class="flex-1"
					clip={false}
					value={Math.min(chosen, rec.points.length - 1)}
					items={rec.points.map((_p, i) => ({ value: i, name: 'Point ' + (i + 1) }))}
					onchange={(/** @type {any} */ v) => (chosen = +v)}
				/>
			</div>
		{/if}
		{#if first}
			<SliderRow
				id="path-point-wait"
				label="Wait (s)"
				min={0}
				max={30}
				step={0.1}
				decimals={1}
				mixed={mixed('wait')}
				value={first.wait ?? 0}
				onchange={(v) => setPoints({ wait: v > 0 ? v : null })}
			/>
			<SliderRow
				id="path-point-speed"
				label="Speed after (m/s)"
				min={0}
				max={10}
				step={0.1}
				decimals={1}
				mixed={mixed('speed')}
				value={first.speed ?? 0}
				onchange={(v) => setPoints({ speed: v > 0 ? v : null })}
			/>
			<p class="text-[length:var(--fs-badge)] text-text-muted">Speed 0 = the path's speed.</p>
			<div class="ui-row items-center gap-2">
				<span class="w-24 shrink-0 text-xs text-text-2">Ease after</span>
				<ThemedSelect
					id="path-point-ease"
					class="flex-1"
					mixed={mixed('ease')}
					value={first.ease ?? 'linear'}
					items={PATH_EASES.map((e) => ({ value: e, name: EASE_NAMES[e] }))}
					onchange={(/** @type {any} */ v) => setPoints({ ease: v })}
				/>
			</div>
			<InsToggle
				id="path-point-gap"
				checked={!!first.gap}
				indeterminate={mixed('gap')}
				title="The walker jumps straight to the next point (no walking in between)"
				onchange={(e) => setPoints({ gap: e.target.checked })}
			>
				Jump to the next point
			</InsToggle>
			<InsToggle
				id="path-point-facing-on"
				checked={typeof first.facing === 'number'}
				title="While waiting here, face a fixed direction instead of the way it arrived"
				onchange={(e) => setPoints({ facing: e.target.checked ? 0 : null })}
			>
				Face a direction while waiting
			</InsToggle>
			{#if typeof first.facing === 'number'}
				<SliderRow
					id="path-point-facing"
					label="Facing (deg)"
					min={-180}
					max={180}
					step={5}
					decimals={0}
					mixed={mixed('facing')}
					value={first.facing}
					onchange={(v) => setPoints({ facing: v })}
				/>
			{/if}
			<div class="ui-row items-center gap-2">
				<label for="path-point-event" class="w-24 shrink-0 text-xs text-text-2">Event</label>
				<input
					id="path-point-event"
					class="ui-input flex-1"
					type="text"
					maxlength="40"
					placeholder={mixed('event') ? 'Several' : 'None'}
					value={shared('event') ?? ''}
					onchange={(e) => setPoints({ event: e.currentTarget.value.trim() || null })}
				/>
			</div>
			<p class="text-[length:var(--fs-badge)] text-text-muted">An On Path Event node fires when a walker arrives here.</p>
		{/if}

		<!-- the scrub ghost: where a walker stands at a moment of one round (local) -->
		<p class="mt-2 text-[length:var(--fs-badge)] uppercase tracking-wide text-text-faint">Preview</p>
		<InsToggle id="path-scrub-on" checked={scrubbing} title="Show a ghost walker you can scrub along one round" onchange={toggleScrub}>
			Scrub ghost
		</InsToggle>
		{#if scrubbing && view}
			<SliderRow
				id="path-scrub"
				label="Time (s)"
				min={0}
				max={Math.max(0.1, view.period)}
				step={0.05}
				decimals={2}
				value={$pathScrub?.t ?? 0}
				onchange={(v) => pathScrub.set({ uuid: object.uuid, t: v })}
			/>
			{@const pose = view.poseAt($pathScrub?.t ?? 0, { start: 0 })}
			{#if pose}
				<p id="path-scrub-readout" class="text-[length:var(--fs-badge)] text-text-muted">
					{pose.kind === 'wait' ? `Waiting at point ${pose.point + 1}` : `Walking to point ${pose.next + 1}`}
				</p>
			{/if}
		{/if}
	</Section>
{/if}
