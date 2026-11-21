<script>
	// 102 M7 — Inspector ▸ Constraints, for one selected object: its constraint stack (look at,
	// copy transform / parent, limit rotation, two-bone IK, chain IK). Add, reorder (the stack runs
	// top to bottom), mute, weight (keyable on the Timeline), target / pole pickers, and a status
	// line from the last frame. LAZY: Inspector loads it with {#await import()}, so the editor's
	// boot graph only carries the runtime. Every write goes through rig/constraintEdit.js.
	import Section from '../../ui/Section.svelte';
	import UiButton from '../../ui/Button.svelte';
	import SliderRow from '../../ui/SliderRow.svelte';
	import ThemedSelect from '../../ui/ThemedSelect.svelte';
	import Checkbox from '../../ui/Checkbox.svelte';
	import { sceneRevision, objectsGroup } from '../../../stores/sceneStore';
	import { AXES } from '$lib/rig/constraintCore.js';
	import { lastResults } from '$lib/rig/constraintRuntime.js';
	import {
		constraintsOf,
		addConstraint,
		updateConstraint,
		removeConstraint,
		moveConstraint,
		setParentOffset,
		beginConstraintGesture,
		endConstraintGesture
	} from '$lib/rig/constraintEdit.js';
	import { selectObject } from '$lib/objectActions';
	import { showToast } from '../../../stores/appStore';

	/** @type {{ object: any }} */
	let { object } = $props();

	const KIND_LABEL = /** @type {Record<string, string>} */ ({
		lookat: 'Look at',
		copy: 'Copy transform',
		limit: 'Limit rotation',
		ik2: 'Two-bone IK',
		ikchain: 'Chain IK'
	});
	const ADD_ITEMS = [
		{ value: 'lookat', name: 'Look at' },
		{ value: 'copy', name: 'Copy transform' },
		{ value: 'parent', name: 'Parent (follow with offset)' },
		{ value: 'limit', name: 'Limit rotation' },
		{ value: 'ik2', name: 'Two-bone IK (arm, leg)' },
		{ value: 'ikchain', name: 'Chain IK (tail, tentacle)' }
	];
	const AXIS_ITEMS = AXES.map((a) => ({ value: a, name: a.toUpperCase() }));

	const list = $derived.by(() => {
		void $sceneRevision;
		return object ? constraintsOf(object.uuid) : [];
	});

	/** status lines refresh a few times a second (the runtime writes them every frame) */
	let tick = $state(0);
	$effect(() => {
		const t = setInterval(() => (tick = (tick + 1) % 1e6), 400);
		return () => clearInterval(t);
	});

	/** named nodes inside an object (bones first) for the bone pickers @param {any} o */
	function bonesOf(o) {
		/** @type {{value: string, name: string}[]} */
		const bones = [];
		/** @type {{value: string, name: string}[]} */
		const parts = [];
		const seen = new Set();
		o?.traverse?.((/** @type {any} */ n) => {
			if (n === o || !n.name || seen.has(n.name) || n.userData?.isHelper) return;
			seen.add(n.name);
			if (n.isBone) bones.push({ value: n.name, name: n.name });
			else parts.push({ value: n.name, name: 'Part: ' + n.name });
		});
		return [...bones, ...parts].slice(0, 400);
	}
	const ownerBones = $derived.by(() => {
		void $sceneRevision;
		return [{ value: '', name: 'This object' }, ...bonesOf(object)];
	});
	/** every object a constraint may target: the scene's objects (not this one), by name */
	const targets = $derived.by(() => {
		void $sceneRevision;
		/** @type {{value: string, name: string}[]} */
		const out = [];
		/** @type {any} */ (/** @type {any} */ ($objectsGroup))?.traverse?.((/** @type {any} */ n) => {
			if (n === $objectsGroup || n.uuid === object?.uuid || !n.parent || n.isBone) return;
			if (n.parent !== $objectsGroup && !n.parent?.userData?.isGroupObject && n.parent?.type !== 'Group') return;
			if (n.userData?.isHelper || n.userData?.transient) return;
			out.push({ value: n.uuid, name: n.name || n.type });
		});
		out.sort((a, b) => a.name.localeCompare(b.name));
		return [{ value: '', name: 'No target' }, ...out.slice(0, 500)];
	});
	/** @param {string} uuid */
	function objectByUuid(uuid) {
		return uuid ? /** @type {any} */ ($objectsGroup)?.getObjectByProperty?.('uuid', uuid) : null;
	}

	/** @param {string} kind */
	function add(kind) {
		if (!object || !kind) return;
		const made = addConstraint(object.uuid, kind === 'parent' ? 'copy' : kind, kind === 'parent' ? { parent: true, scale: true } : {});
		if (!made) showToast('An object takes at most 16 constraints');
	}

	/** the weight scrub: one undo entry per drag (closed after a short pause) */
	/** @type {ReturnType<typeof setTimeout> | null} */
	let gestureTimer = null;
	/** @param {string} id @param {number} w */
	function scrubWeight(id, w) {
		beginConstraintGesture(object.uuid);
		updateConstraint(object.uuid, id, { weight: w });
		if (gestureTimer) clearTimeout(gestureTimer);
		const uuid = object.uuid;
		gestureTimer = setTimeout(() => endConstraintGesture(uuid), 400);
	}

	/** @param {any} c */
	async function keyWeight(c) {
		const { keyConstraintWeight } = await import('$lib/rig/constraintKeys.js');
		const done = keyConstraintWeight(object.uuid, c.id, c.weight, { objectName: object.name, label: 'Weight: ' + (c.name || KIND_LABEL[c.kind]) });
		if (done) showToast('Keyed the weight (' + Math.round(c.weight * 100) + ' %) at ' + done.t.toFixed(2) + ' s on the Timeline');
	}

	/** @param {any} c */
	function status(c) {
		void tick;
		if (c.mute) return 'Muted';
		const r = lastResults.get(object.uuid + '|' + c.id);
		if (!r) return '';
		if (!r.ok) return r.reason === 'off' ? 'Weight 0' : r.reason === 'no target' ? 'Pick a target' : r.reason === 'chain too short' ? 'Not enough parents above this node' : (r.reason ?? '');
		if (r.miss !== undefined && r.miss > 0.005) return 'Out of reach by ' + r.miss.toFixed(2) + ' m';
		return 'On target';
	}
</script>

<Section variant="panel" label="Constraints" aliases={['IK', 'Inverse kinematics', 'Look at', 'Constraint', 'Parent']}>
	<div id="constraints-section" class="flex flex-col gap-2 text-xs">
		{#if !list.length}
			<p class="text-text-muted">Make this object (or one of its bones) look at, follow or reach for another object. Every peer runs the same constraints.</p>
		{/if}
		{#each list as c, i (c.id)}
			<div class="flex flex-col gap-1 rounded border border-border p-1.5" data-constraint={c.id} data-constraint-kind={c.kind}>
				<div class="flex items-center gap-1">
					<b class="min-w-0 flex-1 truncate" title="Runs {i + 1} of {list.length}: the stack runs top to bottom">{i + 1}. {KIND_LABEL[c.kind] ?? 'Newer constraint'}</b>
					{#if KIND_LABEL[c.kind]}
						<UiButton variant="icon" size="sm" icon={c.mute ? 'eye-off' : 'eye'} pressed={!c.mute} title={c.mute ? 'Muted: turn this constraint back on' : 'Mute this constraint'} aria-label={c.mute ? 'Unmute' : 'Mute'} data-constraint-mute onclick={() => updateConstraint(object.uuid, c.id, { mute: !c.mute })} />
						<UiButton variant="icon" size="sm" icon="key" title="Key this weight on the Timeline at the playhead" aria-label="Key weight" data-constraint-key onclick={() => keyWeight(c)} />
					{/if}
					<UiButton variant="icon" size="sm" icon="chevron-up" disabled={i === 0} title="Move up (runs earlier)" aria-label="Move up" onclick={() => moveConstraint(object.uuid, c.id, -1)} />
					<UiButton variant="icon" size="sm" icon="chevron-down" disabled={i === list.length - 1} title="Move down (runs later)" aria-label="Move down" onclick={() => moveConstraint(object.uuid, c.id, 1)} />
					<UiButton variant="icon" size="sm" icon="trash-2" title="Remove this constraint" aria-label="Remove" data-constraint-remove onclick={() => removeConstraint(object.uuid, c.id)} />
				</div>
				{#if KIND_LABEL[c.kind]}
					<SliderRow label="Weight" value={c.weight} min={0} max={1} step={0.01} id={'constraint-weight-' + c.id} onchange={(w) => scrubWeight(c.id, w)} />
					{#if ownerBones.length > 1}
						<label class="flex items-center gap-2" title={c.kind.startsWith('ik') ? 'The tip of the chain (a hand, a foot, the end of a tail)' : 'The bone or part this constraint moves'}>
							<span class="w-20 shrink-0 text-text-muted">{c.kind.startsWith('ik') ? 'Tip' : 'Moves'}</span>
							<ThemedSelect class="min-w-0 flex-1" items={ownerBones} value={c.bone} clip={false} title="Pick a bone or part" onchange={(v) => updateConstraint(object.uuid, c.id, { bone: v })} />
						</label>
					{/if}
					{#if c.kind !== 'limit'}
						{@const tObj = objectByUuid(c.target?.uuid ?? '')}
						<div class="flex items-center gap-2">
							<span class="w-20 shrink-0 text-text-muted">Target</span>
							<ThemedSelect class="min-w-0 flex-1" items={targets} value={c.target?.uuid ?? ''} clip={false} title="The object this constraint aims at, copies or reaches for" id={'constraint-target-' + c.id} onchange={(v) => updateConstraint(object.uuid, c.id, { target: v ? { uuid: v } : null })} />
							<UiButton variant="icon" size="sm" icon="crosshair" disabled={!tObj} title="Select the target (move it with the gizmo)" aria-label="Select target" onclick={() => tObj && selectObject(tObj.uuid)} />
						</div>
						{#if tObj && bonesOf(tObj).length}
							<div class="flex items-center gap-2">
								<span class="w-20 shrink-0 text-text-muted">Target bone</span>
								<ThemedSelect class="min-w-0 flex-1" items={[{ value: '', name: 'The object itself' }, ...bonesOf(tObj)]} value={c.target?.bone ?? ''} clip={false} title="Aim at a bone or part of the target" onchange={(v) => updateConstraint(object.uuid, c.id, { target: { uuid: c.target?.uuid ?? '', ...(v ? { bone: v } : {}) } })} />
							</div>
						{/if}
					{/if}
					{#if c.kind === 'lookat'}
						<div class="flex items-center gap-2">
							<span class="w-20 shrink-0 text-text-muted">Aim axis</span>
							<ThemedSelect class="min-w-0 flex-1" items={AXIS_ITEMS} value={c.aim} clip={false} title="The axis that points at the target (cameras and lights look down -Z)" onchange={(v) => updateConstraint(object.uuid, c.id, { aim: v })} />
						</div>
						<div class="flex items-center gap-2">
							<span class="w-20 shrink-0 text-text-muted">Up axis</span>
							<ThemedSelect class="min-w-0 flex-1" items={AXIS_ITEMS.filter((a) => a.value[1] !== c.aim[1])} value={c.up} clip={false} title="The axis that stays pointing up" onchange={(v) => updateConstraint(object.uuid, c.id, { up: v })} />
						</div>
					{:else if c.kind === 'copy'}
						<div class="flex flex-wrap items-center gap-2" title="Which parts of the target's transform to copy">
							<span class="w-20 shrink-0 text-text-muted">Copy</span>
							{#each ['X', 'Y', 'Z'] as ax, k (ax)}
								<Checkbox label={'Pos ' + ax} checked={c.position[k]} onchange={(v) => updateConstraint(object.uuid, c.id, { position: c.position.map((/** @type {boolean} */ p, /** @type {number} */ j) => (j === k ? v : p)) })} />
							{/each}
							<Checkbox label="Rotation" checked={c.rotation} onchange={(v) => updateConstraint(object.uuid, c.id, { rotation: v })} />
							<Checkbox label="Scale" checked={c.scale} onchange={(v) => updateConstraint(object.uuid, c.id, { scale: v })} />
						</div>
						<Checkbox label="Keep offset (Parent: follow from where it is now)" checked={!!c.offset} disabled={!c.target} onchange={(v) => setParentOffset(object.uuid, c.id, v)} />
					{:else if c.kind === 'limit'}
						{#each ['X', 'Y', 'Z'] as ax, k (ax)}
							<div class="flex items-center gap-2" title={'Clamp the local rotation about ' + ax + ' (degrees)'}>
								<Checkbox label={ax} checked={c.axes[k]} onchange={(v) => updateConstraint(object.uuid, c.id, { axes: c.axes.map((/** @type {boolean} */ a, /** @type {number} */ j) => (j === k ? v : a)) })} />
								<SliderRow label="Min" value={c.min[k]} min={-180} max={180} step={1} decimals={0} onchange={(v) => updateConstraint(object.uuid, c.id, { min: c.min.map((/** @type {number} */ m, /** @type {number} */ j) => (j === k ? v : m)) })} />
								<SliderRow label="Max" value={c.max[k]} min={-180} max={180} step={1} decimals={0} onchange={(v) => updateConstraint(object.uuid, c.id, { max: c.max.map((/** @type {number} */ m, /** @type {number} */ j) => (j === k ? v : m)) })} />
							</div>
						{/each}
					{:else if c.kind === 'ik2'}
						{@const pObj = objectByUuid(c.pole?.uuid ?? '')}
						<div class="flex items-center gap-2">
							<span class="w-20 shrink-0 text-text-muted">Pole</span>
							<ThemedSelect class="min-w-0 flex-1" items={[{ value: '', name: 'Bend as it bends now' }, ...targets.slice(1)]} value={c.pole?.uuid ?? ''} clip={false} title="Where the elbow or knee points" id={'constraint-pole-' + c.id} onchange={(v) => updateConstraint(object.uuid, c.id, { pole: v ? { uuid: v } : null })} />
							<UiButton variant="icon" size="sm" icon="crosshair" disabled={!pObj} title="Select the pole (move it with the gizmo)" aria-label="Select pole" onclick={() => pObj && selectObject(pObj.uuid)} />
						</div>
						<Checkbox label="Tip turns with the target" checked={c.tipRotation} onchange={(v) => updateConstraint(object.uuid, c.id, { tipRotation: v })} />
					{:else if c.kind === 'ikchain'}
						<SliderRow label="Joints" value={c.count} min={2} max={16} step={1} decimals={0} onchange={(v) => updateConstraint(object.uuid, c.id, { count: v })} />
						<SliderRow label="Iterations" value={c.iterations} min={1} max={32} step={1} decimals={0} onchange={(v) => updateConstraint(object.uuid, c.id, { iterations: v })} />
					{/if}
					{#if status(c)}<p class="text-text-muted" data-constraint-status aria-live="polite">{status(c)}</p>{/if}
				{:else}
					<p class="text-text-muted">Made with a newer version of the app: kept and shared, but this version cannot run or edit it.</p>
				{/if}
			</div>
		{/each}
		<div class="flex items-center gap-2">
			<span class="w-20 shrink-0 text-text-muted">Add</span>
			<ThemedSelect class="min-w-0 flex-1" id="constraints-add" items={ADD_ITEMS} value={undefined} placeholder="Add a constraint" clip={false} title="Add a constraint to the bottom of the stack" onchange={(v) => add(v)} />
		</div>
	</div>
</Section>
