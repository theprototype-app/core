<script>
	// 36 X5: Inspector ▸ Physics — collision group + "collides with". Its own file
	// so the Inspector carries one line for it (the settings hot-spot rule). The
	// chips are the shared `tp-seg` control (theme tokens, aria-pressed drives the
	// armed look). Writes go through the Inspector's setPhysics (fanned over the
	// selection, replicated, one undo entry).
	import {
		COLLISION_GROUPS,
		COLLIDES_WITH_GROUPS,
		groupOf,
		normalizeCollidesWith
	} from '$lib/collisionGroups';

	/** @type {{ physics: any, water?: any, onchange: (patch: any) => void }} */
	let { physics, water = null, onchange } = $props();

	const group = $derived(groupOf(physics, water));
	/** the ids this object collides with (absent = every group) */
	const collides = $derived(
		Array.isArray(physics?.collidesWith) ? physics.collidesWith : COLLIDES_WITH_GROUPS.map((g) => g.id)
	);

	/** @param {string} id */
	function toggleCollides(id) {
		const next = collides.includes(id) ? collides.filter((/** @type {string} */ g) => g !== id) : [...collides, id];
		onchange({ collidesWith: normalizeCollidesWith(next) });
	}
</script>

<div id="physics-group-row" class="ui-row items-center gap-2">
	<span class="w-20 shrink-0 text-xs text-text-muted">Group</span>
	<div class="tp-seg flex-wrap" role="group" aria-label="Collision group">
		{#each COLLISION_GROUPS as g (g.id)}
			<button
				type="button"
				class="tp-seg-btn"
				data-group={g.id}
				aria-pressed={group === g.id}
				title={g.id === 'water' ? 'Water/trigger: pass-through, fires On Enter / On Exit' : 'Collision group ' + g.label}
				onclick={() => onchange({ group: g.id === 'default' ? null : g.id })}>{g.id === 'water' ? 'Water' : g.label}</button
			>
		{/each}
	</div>
</div>
<div id="physics-collides-row" class="ui-row items-center gap-2">
	<span class="w-20 shrink-0 text-xs text-text-muted">Collides with</span>
	<div class="tp-seg flex-wrap" role="group" aria-label="Collides with">
		{#each COLLIDES_WITH_GROUPS as g (g.id)}
			<button
				type="button"
				class="tp-seg-btn"
				data-collides={g.id}
				aria-pressed={collides.includes(g.id)}
				title={g.id === 'player' ? 'The player walking in Play — leave it out for a ghost wall' : 'Collide with group ' + g.label}
				onclick={() => toggleCollides(g.id)}>{g.id === 'water' ? 'Water' : g.label}</button
			>
		{/each}
	</div>
</div>
