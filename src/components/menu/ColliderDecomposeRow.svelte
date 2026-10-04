<script>
	// 36 X3: Inspector ▸ Physics — "Decompose": V-HACD on the object's mesh, written as its
	// custom compound collider (replicated, one undo entry). Its own file so the Inspector
	// carries one line for it. The piece budget is a LOCAL pref (how you like to work, not
	// scene data); only the resulting collider is shared.
	import { decomposeCollider, decomposing } from '$lib/colliderDecompose';
	import { safeStorage } from '$lib/safeStorage';
	import { DECOMPOSE_MIN_PIECES, DECOMPOSE_MAX_PIECES, clampPieces } from '$lib/colliderDecomposeCore';

	/** @type {{ uuid: string }} */
	let { uuid } = $props();

	let pieces = $state(clampPieces(Number(safeStorage.getItem('colliderDecomposePieces') ?? 8)));
	const busy = $derived($decomposing === uuid);

	/** @param {any} e */
	function setPieces(e) {
		pieces = clampPieces(e.currentTarget.value);
		try {
			safeStorage.setItem('colliderDecomposePieces', String(pieces));
		} catch {}
	}
</script>

<div id="physics-decompose-row" class="ui-row items-center gap-2">
	<span class="w-20 shrink-0 text-xs text-gray-400">Decompose</span>
	<input
		id="physics-decompose-pieces"
		type="range"
		class="min-w-0 flex-1"
		aria-label="Maximum convex pieces"
		min={DECOMPOSE_MIN_PIECES}
		max={DECOMPOSE_MAX_PIECES}
		step="1"
		value={pieces}
		oninput={setPieces}
	/>
	<span class="w-5 text-right font-mono text-xs text-gray-300">{pieces}</span>
	<button
		id="physics-decompose"
		class="ui-chip bg-gray-600 text-gray-200 hover:bg-gray-500"
		disabled={busy}
		title="Split the mesh into convex pieces (keeps openings; works on dynamic bodies)"
		onclick={() => decomposeCollider(uuid, pieces)}>{busy ? 'Working…' : 'Run'}</button
	>
</div>
