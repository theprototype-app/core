<script>
	// The Shader dock tab (plan SH3). A Flow-family tab whose graph is the SHADER
	// document for the current scope: the selection's own graph, or the scene default.
	//
	// It is a SEPARATE xyflow instance from the node editor on purpose — flowGraphs,
	// allNodes()/allEdges(), nodesync and the flow hash stay byte-untouched. The bridge
	// to `shaderGraphs` is the same shape Nodes.svelte uses for flowNodes/flowEdges:
	// SvelteFlow 1.x binds PLAIN $state.raw arrays, not stores, so the two are mirrored
	// both ways with a re-entrancy guard.
	import { untrack } from 'svelte';
	import { SvelteFlow, Background, BackgroundVariant, Controls } from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import '../../styles/flow.css';
	import { selectedObjects, objectsGroup } from '../../stores/sceneStore';
	import { shaderEditorClose, showToast } from '../../stores/appStore.js';
	import {
		shaderGraphs,
		shaderErrors,
		activeShaderGraph,
		SCENE_GRAPH_KEY,
		setShaderGraphFor,
		detachFrom,
		shaderTargetSupported,
		shaderRefusalReason
	} from '$lib/shaderGraph';
	import { shaderNodeDefs } from '$lib/shaderCatalog';
	import { setDockOccupant, dockHeight, visibleDockKey } from '$lib/bottomDock';
	import DockTabs from '../DockTabs.svelte';
	import ShaderNode from './nodes/ShaderNode.svelte';

	const nodeTypes = Object.fromEntries(shaderNodeDefs().map((def) => [def.key, ShaderNode]));
	const palette = shaderNodeDefs().filter((def) => def.key !== 'surface');
	const groups = [...new Set(palette.map((def) => def.group))];

	// ---- which graph are we editing --------------------------------------------
	// Scope follows the selection SET, never the sticky `selectedObject` (that store
	// deliberately keeps the last object after a deselect, so it can never signal
	// "nothing selected").
	const selectedUuid = $derived($selectedObjects?.length === 1 ? $selectedObjects[0] : null);
	const scope = $derived($activeShaderGraph ?? selectedUuid ?? SCENE_GRAPH_KEY);
	const doc = $derived($shaderGraphs[scope] ?? null);
	const errors = $derived($shaderErrors[scope] ?? []);
	const scopeLabel = $derived(
		scope === SCENE_GRAPH_KEY
			? 'Scene default material'
			: ($objectsGroup?.getObjectByProperty('uuid', scope)?.name || 'Object') + ' — own material'
	);

	// follow the selection unless the user pinned a scope explicitly
	$effect(() => {
		const uuid = selectedUuid;
		untrack(() => {
			if (uuid && $activeShaderGraph && $activeShaderGraph !== SCENE_GRAPH_KEY) activeShaderGraph.set(uuid);
		});
	});

	// ---- the xyflow bridge -----------------------------------------------------
	/** @type {any[]} */
	let nodes = $state.raw([]);
	/** @type {any[]} */
	let edges = $state.raw([]);
	let pushing = false;

	// store -> local (remote edits, undo, scope switches)
	$effect(() => {
		const next = doc;
		untrack(() => {
			pushing = true;
			nodes = (next?.nodes ?? []).map((n) => ({
				...n,
				// the node needs to know which document to write its params into
				data: { ...(n.data ?? {}), __graphKey: scope }
			}));
			edges = next?.edges ?? [];
			pushing = false;
		});
	});

	// local -> store (drags, connects, deletions made by SvelteFlow)
	$effect(() => {
		const localNodes = nodes;
		const localEdges = edges;
		untrack(() => {
			if (pushing || !doc) return;
			const stripped = localNodes.map((n) => {
				const { __graphKey, ...rest } = n.data ?? {};
				return { ...n, data: rest };
			});
			const same =
				JSON.stringify(stripped) === JSON.stringify(doc.nodes) &&
				JSON.stringify(localEdges) === JSON.stringify(doc.edges);
			if (!same) setShaderGraphFor(scope, { nodes: stripped, edges: localEdges });
		});
	});

	// ---- actions ---------------------------------------------------------------
	function createGraph() {
		if (scope !== SCENE_GRAPH_KEY) {
			const object = $objectsGroup?.getObjectByProperty('uuid', scope);
			if (object && !shaderTargetSupported(object)) {
				showToast(shaderRefusalReason(object));
				return;
			}
		}
		setShaderGraphFor(scope, {
			nodes: [
				{ id: 'surface', type: 'surface', position: { x: 320, y: 120 }, data: {} },
				{ id: 'colour', type: 'color', position: { x: 60, y: 120 }, data: { value: '#cccccc' } }
			],
			edges: [
				{ id: 'e-colour', source: 'colour', sourceHandle: 'out', target: 'surface', targetHandle: 'albedo' }
			]
		});
	}

	function removeGraph() {
		if (scope !== SCENE_GRAPH_KEY) {
			const object = $objectsGroup?.getObjectByProperty('uuid', scope);
			if (object) detachFrom(object);
		}
		setShaderGraphFor(scope, null);
	}

	let addOpen = $state(false);

	/** @param {string} key */
	function addNode(key) {
		addOpen = false;
		if (!doc) return;
		const id = key + '_' + Math.random().toString(36).slice(2, 7);
		const next = [
			...doc.nodes,
			{ id, type: key, position: { x: 80 + Math.random() * 120, y: 40 + Math.random() * 200 }, data: {} }
		];
		setShaderGraphFor(scope, { nodes: next });
	}

	// dock presence
	$effect(() => {
		setDockOccupant('shader', !$shaderEditorClose, $dockHeight);
		return () => setDockOccupant('shader', false);
	});
	const dockVisible = $derived($visibleDockKey === 'shader');
</script>

{#if !$shaderEditorClose && dockVisible}
	<div
		id="shader-editor"
		class="shader-editor ui-panel"
		style:height={$dockHeight + 'px'}
	>
		<div class="shader-topbar">
			<DockTabs />
			<span class="shader-scope" id="shader-scope">{scopeLabel}</span>
			<div class="shader-actions">
				{#if doc}
					<button class="ui-button-quiet" id="shader-add" onclick={() => (addOpen = !addOpen)}>
						Add node
					</button>
					<button class="ui-button-quiet" id="shader-remove" onclick={removeGraph}>Detach</button>
				{:else}
					<button class="ui-button-quiet" id="shader-create" onclick={createGraph}>
						Create shader
					</button>
				{/if}
				<button
					class="ui-button-quiet"
					title="Edit the scene default instead"
					id="shader-scope-scene"
					onclick={() => activeShaderGraph.set(SCENE_GRAPH_KEY)}>Scene</button
				>
				{#if selectedUuid}
					<button
						class="ui-button-quiet"
						id="shader-scope-object"
						onclick={() => activeShaderGraph.set(selectedUuid)}>Object</button
					>
				{/if}
				<button class="ui-button-quiet" title="Close" onclick={() => shaderEditorClose.set(true)}>✕</button>
			</div>
		</div>

		{#if addOpen}
			<div class="shader-palette" id="shader-palette">
				{#each groups as group (group)}
					<div class="shader-palette-group">{group}</div>
					{#each palette.filter((d) => d.group === group) as def (def.key)}
						<button class="shader-palette-item" onclick={() => addNode(def.key)}>{def.label}</button>
					{/each}
				{/each}
			</div>
		{/if}

		{#if errors.length}
			<div class="shader-errors" id="shader-errors">
				{#each errors as message, i (i)}<div>{message}</div>{/each}
			</div>
		{/if}

		<div class="shader-canvas">
			{#if doc}
				<SvelteFlow bind:nodes bind:edges {nodeTypes} fitView>
					<Background variant={BackgroundVariant.Dots} />
					<Controls />
				</SvelteFlow>
			{:else}
				<div class="shader-empty" id="shader-empty">
					<p>No shader graph for {scopeLabel.toLowerCase()}.</p>
					<p class="shader-empty-hint">
						Create one to drive this material's colour, glow, roughness or metalness from a node graph.
						Everything you build here replicates to your peers.
					</p>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.shader-editor {
		position: fixed;
		left: 0;
		right: 0;
		bottom: 0;
		z-index: var(--z-bottom, 35);
		display: flex;
		flex-direction: column;
		background: var(--surface, #1f2937);
		border-top: 1px solid rgba(255, 255, 255, 0.1);
	}
	.shader-topbar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 4px 8px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}
	.shader-scope {
		font-size: 11px;
		color: #9ca3af;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.shader-actions {
		margin-left: auto;
		display: flex;
		gap: 4px;
	}
	.shader-canvas {
		position: relative;
		flex: 1;
		min-height: 0;
	}
	.shader-palette {
		position: absolute;
		top: 34px;
		left: 8px;
		z-index: 5;
		max-height: 70%;
		overflow-y: auto;
		background: var(--surface, #1f2937);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 4px;
		padding: 4px;
		display: flex;
		flex-direction: column;
		min-width: 132px;
	}
	.shader-palette-group {
		font-size: 9px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #6b7280;
		padding: 4px 4px 2px;
	}
	.shader-palette-item {
		text-align: left;
		font-size: 11px;
		color: #e5e7eb;
		padding: 2px 4px;
		border-radius: 3px;
	}
	.shader-palette-item:hover {
		background: rgba(255, 255, 255, 0.08);
	}
	.shader-errors {
		background: rgba(180, 40, 40, 0.18);
		border-bottom: 1px solid rgba(220, 60, 60, 0.4);
		color: #fca5a5;
		font-size: 11px;
		padding: 3px 8px;
		max-height: 64px;
		overflow-y: auto;
	}
	.shader-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 6px;
		color: #9ca3af;
		font-size: 12px;
		text-align: center;
		padding: 0 24px;
	}
	.shader-empty-hint {
		max-width: 420px;
		font-size: 11px;
		color: #6b7280;
	}
</style>
