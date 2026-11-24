<script>
	// 64-2d D6: the 2D toolbar's LAYERS panel — the scene's 2D layers front to back. A row picks the
	// layer (selects the group: new text / shapes land on it), the chevrons swap its depth with the
	// neighbour (ONE transformSet undo entry, the ordinary `move` messages), and "New layer" makes a
	// group in front of the rest and marks it a 2D layer. Parallax is edited in the Inspector's 2D
	// layer section; the row shows it. Nothing here is state of its own: it reads the scene.
	import { get } from 'svelte/store';
	import ToolboxWindow from '../ui/ToolboxWindow.svelte';
	import Icon from '../ui/Icon.svelte';
	import { sceneRevision, selectedObject } from '../../stores/sceneStore';
	import { peers } from '../../stores/appStore';
	import { layersFrontToBack, layersOpen } from '$lib/sprite2d/tools2d.js';

	const layers = $derived.by(() => ($sceneRevision >= 0 ? layersFrontToBack() : []));

	/** @param {any} o */
	const pose = (o) => ({ pos: o.position.toArray(), rot: [o.rotation.x, o.rotation.y, o.rotation.z], scale: o.scale.toArray() });

	/** @param {any} layer */
	async function pick(layer) {
		const { applySelectionSet } = await import('$lib/objectActions');
		applySelectionSet([layer.uuid]);
	}

	/** swap the depth of two layers — one undo entry @param {number} i @param {number} j */
	async function swap(i, j) {
		const a = layers[i];
		const b = layers[j];
		if (!a || !b) return;
		const [{ recordTransformSet }, { pokeScene }] = await Promise.all([import('$lib/history'), import('../../stores/sceneStore')]);
		const before = [pose(a), pose(b)];
		let za = a.position.z;
		let zb = b.position.z;
		// equal depths cannot be swapped into an order: open a 1 m step first
		if (za === zb) zb = za - 1;
		a.position.z = zb;
		b.position.z = za;
		const after = [pose(a), pose(b)];
		recordTransformSet([
			{ uuid: a.uuid, before: before[0], after: after[0] },
			{ uuid: b.uuid, before: before[1], after: after[1] }
		]);
		/** @type {any} */
		const peer = get(peers);
		for (const [o, p] of [
			[a, after[0]],
			[b, after[1]]
		])
			peer?.send({ type: 'move', uuid: o.uuid, pos: p.pos, rot: p.rot, scale: p.scale });
		pokeScene();
	}

	async function newLayer() {
		const [{ sceneCommand }, { setLayer2dFor }] = await Promise.all([import('$lib/commandsHandler.svelte'), import('$lib/sprite2d/spriteActions.js')]);
		const front = layers[0];
		sceneCommand('/group Layer');
		/** @type {any} */
		const group = get(selectedObject);
		if (!group?.isGroup) return;
		group.position.z = front ? front.position.z + 1 : 0;
		/** @type {any} */
		const peer = get(peers);
		peer?.send({ type: 'move', uuid: group.uuid, pos: group.position.toArray(), rot: [0, 0, 0], scale: group.scale.toArray() });
		setLayer2dFor(group.uuid, { parallax: 1 });
	}
</script>

<ToolboxWindow id="layers-2d" key="layers2d" title="Layers" width={220} defaultRect={{ left: 88, top: 140 }} onclose={() => layersOpen.set(false)}>
	<ul class="flex flex-col gap-0.5" id="layers-2d-list" aria-label="2D layers, front first">
		{#each layers as layer, i (layer.uuid)}
			{@const sel = $selectedObject?.uuid === layer.uuid}
			<li class="flex items-center gap-1 rounded-sm {sel ? 'bg-surface-active' : ''}" data-layer-uuid={layer.uuid}>
				<button type="button" class="tbx-cmd min-w-0 flex-1 truncate text-start" title="Pick this layer (new things land on it)" onclick={() => pick(layer)}>
					{layer.name || 'Layer'}
					<span class="text-[length:var(--fs-badge)] text-text-muted">· {Number(layer.userData.layer2d.parallax ?? 1)}x · z {+layer.position.z.toFixed(2)}</span>
				</button>
				<button type="button" class="tbx-btn layer2d-up" disabled={i === 0} title="Bring forward" aria-label="Bring {layer.name} forward" onclick={() => swap(i, i - 1)}
					><Icon name="chevron-up" size={16} aria-hidden="true" /></button
				>
				<button
					type="button"
					class="tbx-btn layer2d-down"
					disabled={i === layers.length - 1}
					title="Send back"
					aria-label="Send {layer.name} back"
					onclick={() => swap(i, i + 1)}><Icon name="chevron-down" size={16} aria-hidden="true" /></button
				>
			</li>
		{:else}
			<li class="text-xs text-text-muted">No 2D layers yet.</li>
		{/each}
	</ul>
	<div class="tbx-row mt-1">
		<button type="button" id="layers-2d-new" class="tbx-cmd" title="A new layer in front of the others" onclick={newLayer}><Icon name="plus" size={16} aria-hidden="true" /> New layer</button>
	</div>
</ToolboxWindow>
