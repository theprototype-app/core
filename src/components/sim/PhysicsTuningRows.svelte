<script>
	// 102b row 1: per-object gravity scale + linear / angular damping in Inspector ▸ Physics
	// (dynamic bodies). Its own file so the Inspector edit is one line. Writes
	// `userData.physics.{gravityScale, linearDamping, angularDamping}` through the caller's
	// setPhysics — the shared write path that replicates, records undo, saves with the object
	// and reaches a running simulation. NO key = the scene's value (gravity 1, the scene's
	// damping), so a scene that never touched these stays byte-identical; Reset removes the key.
	import PropRow from '../ui/PropRow.svelte';
	import { scenePhysicsDefaults } from '$lib/scenePhysics';
	import { BODY_TUNING_RANGE } from '$lib/physicsTuning.js';

	/** @type {{object: any, setPhysics: (patch: any) => void, mixed?: (read: (o: any) => any) => boolean}} */
	let { object, setPhysics, mixed = () => false } = $props();

	const p = $derived(object?.userData?.physics ?? {});
	const sceneLinear = $derived($scenePhysicsDefaults.damping?.linear ?? 0);
	const sceneAngular = $derived($scenePhysicsDefaults.damping?.angular ?? 0);

	const rows = $derived([
		{
			key: 'gravityScale',
			id: 'physics-gravity-scale',
			label: 'Gravity ×',
			tip: 'How strongly gravity pulls this body: 1 = normal, 0 = floats in place, below 0 = rises. Reset = 1.',
			value: Number.isFinite(p.gravityScale) ? p.gravityScale : 1,
			scene: 1,
			step: 0.05
		},
		{
			key: 'linearDamping',
			id: 'physics-linear-damping',
			label: 'Air drag',
			tip: `Slows this body's movement over time (linear damping). Reset = the scene's value (${sceneLinear}).`,
			value: Number.isFinite(p.linearDamping) ? p.linearDamping : sceneLinear,
			scene: sceneLinear,
			step: 0.05
		},
		{
			key: 'angularDamping',
			id: 'physics-angular-damping',
			label: 'Spin drag',
			tip: `Slows this body's spinning over time (angular damping). Reset = the scene's value (${sceneAngular}).`,
			value: Number.isFinite(p.angularDamping) ? p.angularDamping : sceneAngular,
			scene: sceneAngular,
			step: 0.05
		}
	]);
</script>

{#each rows as row (row.key)}
	<div data-own={Number.isFinite(p[row.key]) ? '1' : '0'} id={row.id + '-row'}>
		<PropRow
			slider
			id={row.id}
			label={row.label}
			ariaLabel={row.label}
			title={row.tip}
			min={BODY_TUNING_RANGE[/** @type {'gravityScale'} */ (row.key)][0]}
			max={BODY_TUNING_RANGE[/** @type {'gravityScale'} */ (row.key)][1]}
			step={row.step}
			snap={row.step * 10}
			decimals={2}
			value={row.value}
			resetValue={row.scene}
			changed={Number.isFinite(p[row.key])}
			onreset={() => setPhysics({ [row.key]: null })}
			mixed={mixed((o) => o.userData.physics?.[row.key] ?? null)}
			onchange={(/** @type {number} */ v) => setPhysics({ [row.key]: v })}
		/>
	</div>
{/each}
