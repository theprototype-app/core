<script>
	// 57 M11 — the ANIMATION STATES window for one character: its states (a clip, or Move = an
	// idle / walk / run blend by speed), the transitions between them (conditions + crossfade time),
	// its parameters with their live values, the current state highlighted, and the one-click
	// LOCOMOTION PRESET. The graph is the model's config (one undo step and one message per edit);
	// the live reading is local (every peer runs the machine itself). On the shared ToolboxWindow
	// shell: a floating palette on desktop, a bottom sheet on a phone.
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import { setAnimGraph, clipInfo, clipRefsOf, animatedObjects } from '$lib/animatedImports';
	import { objectsGroup } from '../../stores/sceneStore';
	import { locomotionPreset, normalizeAnimGraph, OPS } from '$lib/tpanim/animGraph.js';

	/** @type {{uuid: string, onclose: () => void}} */
	let { uuid, onclose } = $props();

	const root = $derived($objectsGroup?.getObjectByProperty('uuid', uuid) ?? null);
	/** the stored graph (re-read whenever the model's clip state moves — every apply pokes it) */
	let version = $state(0);
	const graph = $derived.by(() => {
		version;
		$animatedObjects;
		return normalizeAnimGraph(root?.userData?.animGraph);
	});
	const clips = $derived.by(() => {
		$animatedObjects;
		return clipInfo(uuid).map((c) => c.name);
	});

	/** @type {any} */
	let runtime = $state(null);
	$effect(() => {
		if (!graph || runtime) return;
		void import('$lib/tpanim/animGraphRuntime.js').then((m) => (runtime = m));
	});
	const readingStore = $derived(runtime?.animStates ?? null);
	/** @type {any} */
	let reading = $state(null);
	$effect(() => {
		if (!readingStore) return;
		return readingStore.subscribe((/** @type {any} */ m) => (reading = m?.[uuid] ?? null));
	});

	/** @param {(g: any) => void} mutate */
	async function edit(mutate) {
		const next = JSON.parse(JSON.stringify(graph ?? { states: [], transitions: [], params: [] }));
		mutate(next);
		await setAnimGraph(uuid, next);
		version++;
	}
	/**
	 * The preset, made GAME-READY: a walk or run that travels (root motion) tells the blend its own
	 * pace — so the feet keep up with the controller instead of sliding — and is switched to
	 * In place, so the controller (not the clip) moves the character.
	 */
	async function preset() {
		const g = locomotionPreset(clips);
		const move = g?.states.find((/** @type {any} */ s) => s.blend);
		const refs = clipRefsOf(root);
		if (move) {
			const { clipFactsFor } = await import('$lib/tpanim/clipEdit.js');
			const { updateClipRef } = await import('$lib/tpanim/clipAssets.js');
			for (const [slot, key] of /** @type {const} */ ([['walk', 'walkSpeed'], ['run', 'runSpeed']])) {
				const ref = refs.find((r) => r.name === move.blend[slot]);
				const f = ref ? await clipFactsFor(ref.hash) : null;
				if (!f || f.travel < 0.1 || !(f.duration > 0)) continue;
				move.blend[key] = Math.round((f.travel / f.duration) * 100) / 100;
				if (ref && ref.mode !== 'inplace') updateClipRef(uuid, ref.name, { mode: 'inplace' });
			}
			if (move.blend.runSpeed <= move.blend.walkSpeed) move.blend.runSpeed = move.blend.walkSpeed * 2;
		}
		await setAnimGraph(uuid, g);
		version++;
	}
	async function removeGraph() {
		await setAnimGraph(uuid, null);
		version++;
	}
	const newId = (/** @type {string} */ base) => {
		const taken = new Set((graph?.states ?? []).map((/** @type {any} */ s) => s.id));
		let id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'state';
		for (let i = 2; taken.has(id); i++) id = base.toLowerCase() + '-' + i;
		return id;
	};
	const paramNames = $derived((graph?.params ?? []).map((/** @type {any} */ p) => p.name));
	const fmtValue = (/** @type {any} */ v) => (typeof v === 'boolean' ? (v ? 'true' : 'false') : Number.isFinite(v) && Math.abs(v) < 1e6 ? Number(v).toFixed(2) : '—');
	const stateName = (/** @type {string} */ id) => (id === '*' ? 'Any state' : graph?.states.find((/** @type {any} */ s) => s.id === id)?.name ?? id);
</script>

<ToolboxWindow id="anim-states" key="animStates" title={'Animation states' + (root?.name ? ' — ' + root.name : '')} width={360} minW={280} defaultRect={{ right: 24, top: 96 }} {onclose}>
	<div class="as-body">
		<div class="tbx-row">
			<button
				id="anim-states-preset"
				class="tbx-primary"
				title="Idle / walk / run blended by speed, jump and fall — from this character's clips, driven by how it moves"
				onclick={preset}>{graph ? 'Replace with the Locomotion preset' : 'Locomotion preset'}</button
			>
			{#if graph}<button class="ui-button-quiet text-ink-warn" onclick={removeGraph} title="Remove the states graph (the clips stay)">Remove</button>{/if}
		</div>
		{#if !clips.length}
			<p class="as-note">This model has no clips yet — drag animation clips onto it first.</p>
		{/if}

		{#if graph}
			<div class="tbx-label">States {reading ? '— now: ' + stateName(reading.state) : ''}</div>
			{#each graph.states as st, i (st.id)}
				<div class="as-state" class:as-live={reading?.state === st.id} data-state={st.id}>
					<input
						class="as-name"
						aria-label="State name"
						value={st.name}
						onchange={(e) => edit((g) => (g.states[i].name = e.currentTarget.value.trim() || st.id))}
					/>
					{#if st.blend}
						<span class="as-kind" title="Idle / walk / run blended by {st.blend.param}">blend · {st.blend.param}</span>
						{#each ['idle', 'walk', 'run'] as slot (slot)}
							<select aria-label={slot + ' clip'} value={st.blend[slot]} onchange={(e) => edit((g) => (g.states[i].blend[slot] = e.currentTarget.value))}>
								<option value="">{slot}: auto</option>
								{#each clips as c (c)}<option value={c}>{c}</option>{/each}
							</select>
						{/each}
					{:else}
						<select aria-label="Clip" value={st.clip ?? ''} onchange={(e) => edit((g) => (g.states[i].clip = e.currentTarget.value))}>
							<option value="">(no clip)</option>
							{#each clips as c (c)}<option value={c}>{c}</option>{/each}
						</select>
						<label class="as-check"><input type="checkbox" class="tbx-check" checked={st.loop !== false} onchange={(e) => edit((g) => (e.currentTarget.checked ? delete g.states[i].loop : (g.states[i].loop = false)))} /> loop</label>
					{/if}
					{#if graph.entry === st.id}<span class="as-kind" title="Where the machine starts">entry</span>{:else}<button class="ui-button-quiet" title="Start here" onclick={() => edit((g) => (g.entry = st.id))}>entry</button>{/if}
					<button class="ui-button-quiet text-ink-warn" aria-label={'Delete state ' + st.name} onclick={() => edit((g) => {
						g.states.splice(i, 1);
						g.transitions = g.transitions.filter((/** @type {any} */ t) => t.from !== st.id && t.to !== st.id);
					})}>✕</button>
				</div>
			{/each}
			<div class="tbx-row">
				<button class="ui-button-quiet" onclick={() => edit((g) => g.states.push({ id: newId('State'), name: 'State', clip: clips[0] ?? '' }))}>+ State</button>
				<button class="ui-button-quiet" onclick={() => edit((g) => g.states.push({ id: newId('Move'), name: 'Move', blend: { param: 'speed', idle: '', walk: '', run: '', walkSpeed: 1.4, runSpeed: 3.5 } }))}>+ Blend by speed</button>
			</div>

			<div class="tbx-label">Transitions</div>
			{#each graph.transitions as tr, ti (ti)}
				<div class="as-trans">
					<div class="as-line">
						<select aria-label="From" value={tr.from} onchange={(e) => edit((g) => (g.transitions[ti].from = e.currentTarget.value))}>
							<option value="*">Any state</option>
							{#each graph.states as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
						</select>
						<span>→</span>
						<select aria-label="To" value={tr.to} onchange={(e) => edit((g) => (g.transitions[ti].to = e.currentTarget.value))}>
							{#each graph.states as s (s.id)}<option value={s.id}>{s.name}</option>{/each}
						</select>
						<label class="as-check" title="Crossfade time">fade <input type="number" min="0" max="3" step="0.05" class="as-num" value={tr.fade} onchange={(e) => edit((g) => (g.transitions[ti].fade = Number(e.currentTarget.value) || 0))} /> s</label>
						<button class="ui-button-quiet text-ink-warn" aria-label="Delete transition" onclick={() => edit((g) => g.transitions.splice(ti, 1))}>✕</button>
					</div>
					{#each tr.when as c, ci (ci)}
						<div class="as-line as-cond">
							<span class="as-kind">{ci ? 'and' : 'when'}</span>
							<select aria-label="Parameter" value={c.param} onchange={(e) => edit((g) => (g.transitions[ti].when[ci].param = e.currentTarget.value))}>
								{#each paramNames.includes(c.param) ? paramNames : [c.param, ...paramNames] as p (p)}<option value={p}>{p}</option>{/each}
							</select>
							<select aria-label="Test" value={c.op} onchange={(e) => edit((g) => (g.transitions[ti].when[ci].op = e.currentTarget.value))}>
								{#each OPS as op (op)}<option value={op}>{op}</option>{/each}
							</select>
							{#if !['true', 'false', 'trigger'].includes(c.op)}
								<input type="number" step="0.1" class="as-num" aria-label="Value" value={c.value ?? 0} onchange={(e) => edit((g) => (g.transitions[ti].when[ci].value = Number(e.currentTarget.value) || 0))} />
							{/if}
							<button class="ui-button-quiet" aria-label="Delete condition" onclick={() => edit((g) => g.transitions[ti].when.splice(ci, 1))}>✕</button>
						</div>
					{/each}
					<button class="ui-button-quiet as-add" onclick={() => edit((g) => g.transitions[ti].when.push({ param: paramNames[0] ?? 'speed', op: '>', value: 0 }))}>+ condition</button>
				</div>
			{/each}
			{#if graph.states.length > 1}
				<button class="ui-button-quiet" onclick={() => edit((g) => g.transitions.push({ from: g.states[0].id, to: g.states[1].id, fade: 0.2, when: [] }))}>+ Transition</button>
			{/if}

			<div class="tbx-label">Parameters {graph.driver === 'motion' ? '— speed, vy, grounded come from how it moves' : ''}</div>
			{#each graph.params as p, pi (p.name)}
				<div class="as-line">
					<span class="as-pname">{p.name}</span>
					<span class="as-kind">{p.type}</span>
					<span class="as-val" data-param={p.name}>{fmtValue(reading?.params?.[p.name])}</span>
					{#if p.type === 'trigger'}
						<button class="ui-button-quiet text-accent-text" onclick={() => runtime?.fireAnimTrigger(uuid, p.name)} title="Fire it on every peer">Fire</button>
					{/if}
					<button class="ui-button-quiet text-ink-warn" aria-label={'Delete parameter ' + p.name} onclick={() => edit((g) => g.params.splice(pi, 1))}>✕</button>
				</div>
			{/each}
			<div class="tbx-row">
				<button class="ui-button-quiet" onclick={() => edit((g) => g.params.push({ name: 'param' + (g.params.length + 1), type: 'float', default: 0 }))}>+ Number</button>
				<button class="ui-button-quiet" onclick={() => edit((g) => g.params.push({ name: 'flag' + (g.params.length + 1), type: 'bool', default: false }))}>+ Yes/no</button>
				<button class="ui-button-quiet" onclick={() => edit((g) => g.params.push({ name: 'trigger' + (g.params.length + 1), type: 'trigger' }))}>+ Trigger</button>
				<label class="as-check" title="Fill speed / vy / grounded from how the object moves (the character controller, an NPC's logic)">
					<input type="checkbox" class="tbx-check" checked={graph.driver === 'motion'} onchange={(e) => edit((g) => (g.driver = e.currentTarget.checked ? 'motion' : 'none'))} /> from its motion
				</label>
			</div>
		{/if}
	</div>
</ToolboxWindow>

<style>
	.as-body {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		grid-column: 1 / -1;
		font-size: var(--fs-desc);
	}
	.as-note {
		color: var(--text-muted);
		margin: 0;
	}
	.as-state,
	.as-trans {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-1);
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
	}
	.as-trans {
		flex-direction: column;
		align-items: stretch;
	}
	.as-live {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.as-line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1);
	}
	.as-cond {
		padding-left: var(--space-2);
	}
	.as-name {
		flex: 1 1 6rem;
		min-width: 0;
	}
	.as-kind {
		color: var(--text-faint);
		font-size: 10px;
	}
	.as-pname {
		flex: 1 1 auto;
	}
	.as-val {
		font-variant-numeric: tabular-nums;
		color: var(--text-muted);
		min-width: 3.5rem;
		text-align: right;
	}
	.as-num {
		width: 3.5rem;
	}
	.as-check {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		color: var(--text-muted);
	}
	.as-add {
		align-self: flex-start;
	}
	.as-body select,
	.as-body input:not([type='checkbox']) {
		background: var(--surface-inset);
		border: 1px solid var(--border);
		border-radius: var(--radius-input);
		color: var(--text);
		padding: 1px 4px;
		max-width: 100%;
	}
</style>
