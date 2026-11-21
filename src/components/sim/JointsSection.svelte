<script>
	// 102b row 2: Inspector ▸ Physics ▸ Joints — every joint touching the selection, with what its kind
	// can be tuned by (hinge / slider axis and limits, spring rest length / stiffness / damping, rope
	// length, whether the two bodies still collide), a delete per joint, and an Add row when exactly
	// two objects are selected. Its own file so the Inspector edit is one line. Writes go through
	// joints.js (updateJoint / createJoint / deleteJoint): replicated, undoable, saved with the scene;
	// a running simulation rebuilds the edited joint at once. Joint gizmos show in the viewport for
	// the joints listed here (jointHelpers.js).
	import Icon from '../ui/Icon.svelte';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import PropRow from '../ui/PropRow.svelte';
	import UiButton from '../ui/Button.svelte';
	import InsToggle from '../menu/inspector/InsToggle.svelte';
	import { objectsGroup } from '../../stores/sceneStore';
	import { sceneJoints, createJoint, deleteJoint, updateJoint } from '$lib/joints';
	import { JOINT_LABELS, jointKindOf, JOINT_RANGE } from '$lib/physicsTuning.js';

	/** @type {{targets: string[]}} */
	let { targets = [] } = $props();

	const joints = $derived($sceneJoints.filter((j) => targets.includes(j.a) || targets.includes(j.b)));

	/** @type {Record<string, string>} */
	const ICONS = {
		fixed: 'tool:joint-weld',
		revolute: 'tool:joint-hinge',
		spherical: 'tool:joint-ball',
		prismatic: 'tool:joint-slider',
		spring: 'tool:joint-spring',
		rope: 'tool:joint-rope'
	};
	const ADD_KINDS = [
		{ value: 'fixed', name: 'Weld' },
		{ value: 'revolute', name: 'Hinge' },
		{ value: 'spherical', name: 'Ball' },
		{ value: 'prismatic', name: 'Slider' },
		{ value: 'spring', name: 'Spring' },
		{ value: 'rope', name: 'Rope' }
	];
	const AXES = [
		{ value: 'x', name: 'X' },
		{ value: 'y', name: 'Y' },
		{ value: 'z', name: 'Z' }
	];

	/** @param {string} uuid */
	function nameOf(uuid) {
		const o = $objectsGroup?.getObjectByProperty?.('uuid', uuid);
		return o?.name || o?.type || 'an object';
	}
	/** @param {any} def */
	const kindOf = (def) => jointKindOf(def.kind) ?? 'fixed';
	/** @param {any} def */
	const axisOf = (def) => (def.axisA?.[0] ? 'x' : def.axisA?.[2] ? 'z' : 'y');
	const deg = (/** @type {number} */ r) => Math.round((r * 180) / Math.PI * 10) / 10;
	const rad = (/** @type {number} */ d) => (d * Math.PI) / 180;

	/** set one end of a limits pair, keeping min <= max @param {any} def @param {0|1} end @param {number} v */
	function setLimit(def, end, v) {
		const l = [...(def.limits ?? [0, 0])];
		l[end] = v;
		if (l[0] > l[1]) l[end === 0 ? 1 : 0] = v;
		updateJoint(def.id, { limits: l });
	}
	/** @param {any} def @param {boolean} on */
	function toggleLimits(def, on) {
		if (!on) return updateJoint(def.id, { limits: null });
		updateJoint(def.id, { limits: kindOf(def) === 'prismatic' ? [-0.5, 0.5] : [-Math.PI / 4, Math.PI / 4] });
	}
	/** @param {string} kind */
	function addJoint(kind) {
		if (targets.length !== 2) return;
		createJoint(kind, targets[0], targets[1], 'y');
	}
</script>

<div id="physics-joints" class="mt-2 flex flex-col gap-1" data-count={joints.length}>
	<p class="px-1 text-[length:var(--fs-badge)] uppercase tracking-wider text-text-faint">Joints</p>
	{#if !joints.length}
		<p id="physics-joints-empty" class="text-xs text-text-muted">
			{targets.length === 2 ? 'No joint between these two yet.' : 'Select two objects to join them.'}
		</p>
	{/if}
	{#each joints as def (def.id)}
		{@const kind = kindOf(def)}
		<div class="physics-joint flex flex-col gap-1 rounded-sm border border-border px-1 py-1" data-joint={def.id} data-kind={kind}>
			<div class="ui-row items-center gap-2">
				<Icon name={ICONS[kind]} size={16} aria-hidden="true" />
				<span class="min-w-0 flex-1 truncate text-xs text-text-2" title="{JOINT_LABELS[kind]}: {nameOf(def.a)} and {nameOf(def.b)}">
					{JOINT_LABELS[kind]} · {nameOf(def.a)} – {nameOf(def.b)}
				</span>
				<UiButton
					variant="icon"
					size="sm"
					class="physics-joint-delete"
					title="Delete this joint (the objects stay)"
					aria-label="Delete {JOINT_LABELS[kind]} joint"
					onclick={() => deleteJoint(def.id)}><Icon name="trash-2" size={16} class="ico-danger" aria-hidden="true" /></UiButton
				>
			</div>
			{#if kind === 'revolute' || kind === 'prismatic'}
				<div class="ui-row items-center gap-2">
					<span class="w-20 shrink-0 text-xs text-text-muted" title="The first object's local axis the joint turns about or slides along">Axis</span>
					<ThemedSelect
						class="physics-joint-axis"
						title="The first object's local axis the joint turns about or slides along"
						items={AXES}
						value={axisOf(def)}
						onchange={(/** @type {any} */ v) => updateJoint(def.id, { axis: v })}
					/>
				</div>
				<InsToggle
					class="physics-joint-limits"
					title={kind === 'prismatic' ? 'Stop the slide at a minimum and maximum distance' : 'Stop the hinge at a minimum and maximum angle'}
					checked={Array.isArray(def.limits)}
					onchange={(/** @type {any} */ e) => toggleLimits(def, e.currentTarget.checked)}>Limits</InsToggle
				>
				{#if Array.isArray(def.limits)}
					{#each [0, 1] as end (end)}
						<PropRow
							slider
							class="physics-joint-limit"
							label={end === 0 ? 'Min' : 'Max'}
							ariaLabel={(end === 0 ? 'Minimum ' : 'Maximum ') + (kind === 'prismatic' ? 'slide, metres' : 'angle, degrees')}
							title={kind === 'prismatic' ? 'How far the second object may slide from where it was joined, in metres' : 'How far the hinge may turn from where it was joined, in degrees'}
							min={kind === 'prismatic' ? -5 : -180}
							max={kind === 'prismatic' ? 5 : 180}
							step={kind === 'prismatic' ? 0.05 : 1}
							decimals={kind === 'prismatic' ? 2 : 0}
							value={kind === 'prismatic' ? def.limits[end] : deg(def.limits[end])}
							onchange={(/** @type {number} */ v) => setLimit(def, /** @type {0|1} */ (end), kind === 'prismatic' ? v : rad(v))}
						/>
					{/each}
				{/if}
			{/if}
			{#if kind === 'spring'}
				<PropRow slider class="physics-joint-rest" label="Rest length" ariaLabel="Rest length, metres" title="The distance the spring pulls the two points back to, in metres"
					min={JOINT_RANGE.rest[0]} max={10} step={0.05} decimals={2} value={def.rest ?? 1}
					onchange={(/** @type {number} */ v) => updateJoint(def.id, { rest: v })} />
				<PropRow slider class="physics-joint-stiffness" label="Stiffness" ariaLabel="Spring stiffness" title="How hard the spring pulls: 10 is soft, 500 is stiff"
					min={0} max={1000} step={1} decimals={0} value={def.stiffness ?? 50}
					onchange={(/** @type {number} */ v) => updateJoint(def.id, { stiffness: v })} />
				<PropRow slider class="physics-joint-damping" label="Damping" ariaLabel="Spring damping" title="How fast the bounce dies away: 0 bounces for ever"
					min={0} max={50} step={0.1} decimals={1} value={def.damping ?? 2}
					onchange={(/** @type {number} */ v) => updateJoint(def.id, { damping: v })} />
			{/if}
			{#if kind === 'rope'}
				<PropRow slider class="physics-joint-length" label="Length" ariaLabel="Rope length, metres" title="The furthest apart the two points can get, in metres; closer is free"
					min={JOINT_RANGE.length[0]} max={20} step={0.05} decimals={2} value={def.length ?? 1}
					onchange={(/** @type {number} */ v) => updateJoint(def.id, { length: v })} />
			{/if}
			{#if kind !== 'fixed'}
				<InsToggle
					class="physics-joint-contacts"
					title="Off = the two joined objects pass through each other (a wheel in its arch, a door in its frame)"
					checked={def.contacts !== false}
					onchange={(/** @type {any} */ e) => updateJoint(def.id, { contacts: e.currentTarget.checked })}>The two collide</InsToggle
				>
			{/if}
		</div>
	{/each}
	{#if targets.length === 2}
		<div class="ui-row items-center gap-2">
			<span class="w-20 shrink-0 text-xs text-text-muted" title="Join the two selected objects. Ball, hinge and slider hold at the second object's origin; spring and rope tie the two origins">Add joint</span>
			<ThemedSelect
				id="physics-joint-add"
				title="Join the two selected objects. Ball, hinge and slider hold at the second object's origin; spring and rope tie the two origins"
				clip={false}
				placeholder="Choose a kind"
				items={ADD_KINDS}
				value={undefined}
				onchange={(/** @type {any} */ v) => addJoint(v)}
			/>
		</div>
	{/if}
</div>
