<script>
	// The Shader editor dock tab (plan SH3).
	//
	// SCOPE FOLLOWS THE SELECTION, exactly like the node editor's flow graphs: nothing
	// selected edits the SCENE default material, one object selected edits that object's
	// own. There is no scope switch to get wrong — deselect to go back to the scene — and
	// a scope with no graph gets one centred Create button (the `#flow-empty-state`
	// shape). Selection is read from the SET, never the sticky `selectedObject`, which
	// keeps the last object after a deselect and so can never signal "nothing selected".
	//
	// Separate xyflow instance from the node editor on purpose: flowGraphs,
	// allNodes()/allEdges(), nodesync and the flow hash stay byte-untouched. The bridge to
	// `shaderGraphs` is the Nodes.svelte shape — SvelteFlow 1.x binds PLAIN $state.raw
	// arrays, not stores, so the two are mirrored both ways behind a re-entrancy guard.
	import { untrack } from 'svelte';
	import { Info, Settings, Trash2 } from '@lucide/svelte';
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		MarkerType,
		useSvelteFlow
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import '../../styles/flow.css';
	import { selectedObjects, objectsGroup } from '../../stores/sceneStore';
	import { shaderEditorClose, showToast } from '../../stores/appStore.js';
	import {
		shaderGraphs,
		shaderErrors,
		SCENE_GRAPH_KEY,
		setShaderGraphFor,
		detachFrom,
		shaderTargetSupported,
		shaderRefusalReason
	} from '$lib/shaderGraph';
	import { beginShaderGesture, endShaderGesture } from '$lib/shaderSync';
	import { shaderNodeDefs, shaderNodeDef, SURFACE_NODE } from '$lib/shaderCatalog';
	import { setDockOccupant, dockHeight, visibleDockKey } from '$lib/bottomDock';
	import DockTabs from '../DockTabs.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import ShaderNode from './nodes/ShaderNode.svelte';
	import ShaderSidebar from './ShaderSidebar.svelte';
	import GraphTree from './GraphTree.svelte';
	import ShaderTexturePicker from './nodes/ShaderTexturePicker.svelte';
	import ShaderVectorInput from './nodes/ShaderVectorInput.svelte';
	import DragRow from '../ui/DragRow.svelte';

	const nodeTypes = Object.fromEntries(shaderNodeDefs().map((def) => [def.key, ShaderNode]));
	const catalog = shaderNodeDefs().filter((def) => def.key !== SURFACE_NODE);
	const groups = [...new Set(catalog.map((def) => def.group))];
	const { screenToFlowPosition } = useSvelteFlow();

	const LS = typeof localStorage !== 'undefined' ? localStorage : null;

	// ---- scope: purely selection-driven ----------------------------------------
	const selectedUuid = $derived($selectedObjects?.length === 1 ? $selectedObjects[0] : null);
	const scope = $derived(selectedUuid ?? SCENE_GRAPH_KEY);
	const doc = $derived($shaderGraphs[scope] ?? null);
	const errors = $derived($shaderErrors[scope] ?? []);
	const ownerName = $derived(
		scope === SCENE_GRAPH_KEY
			? 'The scene'
			: $objectsGroup?.getObjectByProperty('uuid', scope)?.name || 'This object'
	);
	const scopeLabel = $derived(
		scope === SCENE_GRAPH_KEY ? 'Scene default material' : ownerName + ' — own material'
	);

	// ---- graph settings (LOCAL prefs, the node editor's set) -------------------
	let propsOpen = $state(LS?.getItem('shaderPropsOpen') !== 'false');
	let paletteOpen = $state(LS?.getItem('shaderPaletteOpen') !== 'false');
	let propsTab = $state(LS?.getItem('shaderPropsTab') || 'settings');
	let edgeStyle = $state(LS?.getItem('shaderEdgeStyle') ?? 'bezier');
	let bgPattern = $state(LS?.getItem('shaderBg') ?? 'dots');
	let showMinimap = $state(LS?.getItem('shaderMinimap') === 'true');
	let snapToGrid = $state(LS?.getItem('shaderSnap') === 'true');
	$effect(() => {
		LS?.setItem('shaderPropsOpen', String(propsOpen));
		LS?.setItem('shaderPaletteOpen', String(paletteOpen));
		LS?.setItem('shaderPropsTab', propsTab);
		LS?.setItem('shaderEdgeStyle', edgeStyle);
		LS?.setItem('shaderBg', bgPattern);
		LS?.setItem('shaderMinimap', String(showMinimap));
		LS?.setItem('shaderSnap', String(snapToGrid));
	});
	const bgVariant = $derived(
		bgPattern === 'lines'
			? BackgroundVariant.Lines
			: bgPattern === 'cross'
				? BackgroundVariant.Cross
				: BackgroundVariant.Dots
	);

	// ---- the xyflow bridge ------------------------------------------------------
	/** @type {any[]} */
	let nodes = $state.raw([]);
	/** @type {any[]} */
	let edges = $state.raw([]);
	let pushing = false;

	$effect(() => {
		const next = doc;
		const key = scope;
		untrack(() => {
			pushing = true;
			nodes = (next?.nodes ?? []).map((/** @type {any} */ n) => ({
				...n,
				// the card needs to know which document to write its params into
				data: { ...(n.data ?? {}), __graphKey: key }
			}));
			edges = next?.edges ?? [];
			pushing = false;
		});
	});

	$effect(() => {
		const localNodes = nodes;
		const localEdges = edges;
		untrack(() => {
			if (pushing || !doc) return;
			const stripped = localNodes.map((/** @type {any} */ n) => {
				const { __graphKey, ...rest } = n.data ?? {};
				return { ...n, data: rest };
			});
			if (
				JSON.stringify(stripped) !== JSON.stringify(doc.nodes) ||
				JSON.stringify(localEdges) !== JSON.stringify(doc.edges)
			)
				setShaderGraphFor(scope, { nodes: stripped, edges: localEdges });
		});
	});

	// ---- the selected node, for the properties pane ----------------------------
	const selectedNode = $derived(nodes.find((/** @type {any} */ n) => n.selected) ?? null);
	const selectedDef = $derived(selectedNode ? shaderNodeDef(selectedNode.type) : null);
	// SH7: the uniform NAMES this node's params compile to. Mirrors the compiler's naming
	// rule (`u_<nodeId>_<param>`) — the one place a user can read it, since a Set Shader
	// Uniform flow node has to name a uniform to write it.
	const uniformNames = $derived(
		(selectedDef?.params ?? [])
			.filter((/** @type {any} */ p) => p.uniform && p.type !== 'texture')
			.map((/** @type {any} */ p) => 'u_' + String(selectedNode?.id ?? '').replace(/[^A-Za-z0-9_]/g, '_') + '_' + p.name)
	);

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
				{ id: 'surface', type: SURFACE_NODE, position: { x: 380, y: 120 }, data: {} },
				{ id: 'colour', type: 'color', position: { x: 90, y: 130 }, data: { value: '#cccccc' } }
			],
			edges: [
				{
					id: 'e-colour',
					source: 'colour',
					sourceHandle: 'out',
					target: 'surface',
					targetHandle: 'albedo'
				}
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

	/** @param {string} key @param {{x:number,y:number}} [at] */
	function addNode(key, at) {
		if (!doc) return;
		const id = key + '_' + Math.random().toString(36).slice(2, 7);
		setShaderGraphFor(scope, {
			nodes: [...doc.nodes, { id, type: key, position: at ?? { x: 140, y: 120 }, data: {} }]
		});
	}

	/** @param {string} key */
	function addNodeAtCentre(key) {
		const box = paneEl?.getBoundingClientRect();
		const at = box
			? screenToFlowPosition({ x: box.left + box.width / 2, y: box.top + box.height / 2 })
			: undefined;
		addNode(key, at);
	}

	/** @param {string[]} ids */
	function deleteEdges(ids) {
		if (!doc || !ids.length) return;
		setShaderGraphFor(scope, {
			edges: doc.edges.filter((/** @type {any} */ e) => !ids.includes(e.id))
		});
	}

	/** @param {string} id */
	function deleteNode(id) {
		if (!doc) return;
		setShaderGraphFor(scope, {
			nodes: doc.nodes.filter((/** @type {any} */ n) => n.id !== id),
			// an orphaned edge would make the compiler walk a dangling reference
			edges: doc.edges.filter((/** @type {any} */ e) => e.source !== id && e.target !== id)
		});
	}

	/** @param {string} id */
	function disconnectNode(id) {
		if (!doc) return;
		setShaderGraphFor(scope, {
			edges: doc.edges.filter((/** @type {any} */ e) => e.source !== id && e.target !== id)
		});
	}

	/** @param {string} id */
	function duplicateNode(id) {
		if (!doc) return;
		const src = doc.nodes.find((/** @type {any} */ n) => n.id === id);
		if (!src) return;
		setShaderGraphFor(scope, {
			nodes: [
				...doc.nodes,
				{
					...src,
					id: src.type + '_' + Math.random().toString(36).slice(2, 7),
					position: { x: src.position.x + 32, y: src.position.y + 32 },
					data: { ...(src.data ?? {}) }
				}
			]
		});
	}

	// ---- context menus (the node editor's shape) -------------------------------
	/** @type {any} */
	let menu = $state(null);
	/** @type {HTMLDivElement|null} */
	let paneEl = $state(null);

	const onPaneContextMenu = (/** @type {any} */ arg) => {
		const event = arg?.event ?? arg;
		event.preventDefault?.();
		if (!doc) return;
		const at = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [
				// the shared context-menu FILTER: flattens every group as "Group ▸ Node"
				// with the same ranking as everywhere else, so typing searches the catalog
				{ label: 'Search nodes…', revealFilter: true },
				...groups.map((group) => ({
					label: group,
					children: catalog
						.filter((def) => def.group === group)
						.map((def) => ({ label: def.label, action: () => addNode(def.key, at) }))
				}))
			]
		};
	};

	const onNodeContextMenu = (/** @type {any} */ arg) => {
		const { node, event } = arg;
		event.preventDefault?.();
		const id = node.id;
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [
				{ label: 'Duplicate', action: () => duplicateNode(id) },
				{ label: 'Disconnect all', action: () => disconnectNode(id) },
				// the Surface output is the graph's terminal — there is exactly one, and a
				// graph without it cannot compile at all
				...(node.type === SURFACE_NODE
					? []
					: [{ label: 'Delete node', danger: true, action: () => deleteNode(id) }])
			]
		};
	};

	const onEdgeContextMenu = (/** @type {any} */ arg) => {
		const { edge, event } = arg;
		event.preventDefault?.();
		const id = edge.id;
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [{ label: 'Disconnect', danger: true, action: () => deleteEdges([id]) }]
		};
	};

	// Delete/Backspace: xyflow removes them from the bound arrays and the mirror writes
	// through, but a removed NODE must take its edges with it.
	const ondelete = (/** @type {any} */ arg) => {
		const deletedNodes = arg?.nodes ?? [];
		if (!deletedNodes.length || !doc) return;
		const ids = deletedNodes.map((/** @type {any} */ n) => n.id);
		setShaderGraphFor(scope, {
			edges: doc.edges.filter(
				(/** @type {any} */ e) => !ids.includes(e.source) && !ids.includes(e.target)
			)
		});
	};

	// refuse a connection GLSL cannot make sense of: a texture sampler is an OBJECT, not a
	// number, so it may only feed a socket that expects one. Everything else coerces.
	const isValidConnection = (/** @type {any} */ connection) => {
		const from = nodes.find((/** @type {any} */ n) => n.id === connection.source);
		const to = nodes.find((/** @type {any} */ n) => n.id === connection.target);
		if (!from || !to) return false;
		const out = (shaderNodeDef(from.type)?.outputs ?? []).find(
			(/** @type {any} */ o) => o.name === connection.sourceHandle
		);
		const inp = (shaderNodeDef(to.type)?.inputs ?? []).find(
			(/** @type {any} */ i) => i.name === connection.targetHandle
		);
		if (!out || !inp) return true;
		return (out.type === 'sampler2D') === (inp.type === 'sampler2D');
	};

	/** @param {DragEvent} event */
	function onDrop(event) {
		event.preventDefault();
		const key = event.dataTransfer?.getData('application/shadernode');
		if (!key) return;
		addNode(key, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
	}

	/** @param {string} name @param {any} value */
	function writeSelectedParam(name, value) {
		if (!selectedNode || !doc) return;
		setShaderGraphFor(scope, {
			nodes: doc.nodes.map((/** @type {any} */ n) =>
				n.id === selectedNode.id ? { ...n, data: { ...(n.data ?? {}), [name]: value } } : n
			)
		});
	}

	// dock presence
	$effect(() => {
		setDockOccupant('shader', !$shaderEditorClose, $dockHeight);
		return () => setDockOccupant('shader', false);
	});
	const dockVisible = $derived($visibleDockKey === 'shader');
</script>

{#if !$shaderEditorClose && dockVisible}
	<div id="shader-editor" class="shader-editor ui-panel" style:height={$dockHeight + 'px'}>
		<div class="shader-topbar">
			<DockTabs />
			<span class="shader-scope" id="shader-scope">{scopeLabel}</span>
			<div class="shader-actions">
				{#if doc}
					<button
						class="ui-button-quiet"
						id="shader-remove"
						title="Remove this shader graph and restore the material"
						aria-label="Remove this shader graph"
						onclick={removeGraph}
					>
						<Trash2 size={14} aria-hidden="true" />
					</button>
				{/if}
				<button
					class="ui-button-quiet"
					title="Close"
					aria-label="Close the shader editor"
					onclick={() => shaderEditorClose.set(true)}>✕</button
				>
			</div>
		</div>

		{#if errors.length}
			<div class="shader-errors" id="shader-errors">
				{#each errors as message, i (i)}<div>{message}</div>{/each}
			</div>
		{/if}

		<div class="shader-body">
			{#if paletteOpen}
				<div class="shader-side shader-side-left">
					<!-- #20 P7: the graph navigator sits ABOVE the palette in the same pane -->
					<GraphTree
						kind="shader"
						documents={$shaderGraphs}
						sceneKey={SCENE_GRAPH_KEY}
						label="Shaders"
					/>
					<div class="shader-side-scroll">
						<ShaderSidebar onPick={addNodeAtCentre} />
					</div>
				</div>
			{/if}
			<button
				id="shader-palette-toggle"
				class="shader-divider"
				title={paletteOpen ? 'Hide the node palette' : 'Show the node palette'}
				aria-label="Toggle the node palette"
				onclick={() => (paletteOpen = !paletteOpen)}>{paletteOpen ? '‹' : '›'}</button
			>

			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="shader-canvas"
				bind:this={paneEl}
				ondrop={onDrop}
				ondragover={(e) => e.preventDefault()}
			>
				{#if doc}
					<SvelteFlow
						bind:nodes
						bind:edges
						{nodeTypes}
						{ondelete}
						{isValidConnection}
						onpanecontextmenu={onPaneContextMenu}
						onnodecontextmenu={onNodeContextMenu}
						onedgecontextmenu={onEdgeContextMenu}
						snapGrid={snapToGrid ? [16, 16] : undefined}
						defaultEdgeOptions={{
							type: edgeStyle,
							markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
						}}
						deleteKey={['Backspace', 'Delete']}
						fitView
						minZoom={0.4}
						maxZoom={1.4}
					>
						<Background variant={bgVariant} />
						<Controls />
						{#if showMinimap}<MiniMap />{/if}
					</SvelteFlow>
				{:else}
					<!-- the `#flow-empty-state` shape: ONE centred call to action -->
					<div id="shader-empty-state" class="shader-empty">
						<p class="text-sm text-gray-300">
							<span class="font-semibold text-gray-100">{ownerName}</span> has no shader yet
						</p>
						<button id="shader-create-btn" class="shader-create" onclick={createGraph}>
							Create shader
						</button>
						<p class="text-[11px] text-gray-500">
							{scope === SCENE_GRAPH_KEY
								? 'A scene shader drives every object that has no shader of its own'
								: 'Deselect to edit the scene-wide shader instead'}
						</p>
					</div>
				{/if}
			</div>

			<button
				id="shader-props-toggle"
				class="shader-divider"
				title={propsOpen ? 'Hide properties' : 'Show properties'}
				aria-label="Toggle the properties panel"
				onclick={() => (propsOpen = !propsOpen)}>{propsOpen ? '›' : '‹'}</button
			>
			{#if propsOpen}
				<div class="shader-side shader-side-right" id="shader-props">
					<div class="shader-props-tabs">
						<button
							class:active={propsTab === 'info'}
							title="Selected node"
							aria-label="Selected node properties"
							onclick={() => (propsTab = 'info')}><Info size={13} aria-hidden="true" /></button
						>
						<button
							class:active={propsTab === 'settings'}
							title="Graph settings"
							aria-label="Graph settings"
							onclick={() => (propsTab = 'settings')}
							><Settings size={13} aria-hidden="true" /></button
						>
					</div>

					{#if propsTab === 'info' && selectedNode && selectedDef}
						<div class="shader-props-body" id="shader-props-node">
							<div class="shader-props-title">{selectedDef.label}</div>
							<!-- the MANUAL line for this node, straight from the catalog — the same text
							     the docs-site reference table is built from, so the two cannot drift -->
							{#if selectedDef.doc}
								<p class="shader-doc" id="shader-node-doc">{selectedDef.doc}</p>
							{/if}
							<label class="shader-field">
								<span>name</span>
								<input
									type="text"
									value={selectedNode.data?.label ?? ''}
									placeholder={selectedDef.label}
									onchange={(e) => writeSelectedParam('label', e.currentTarget.value)}
								/>
							</label>
							{#each selectedDef.params ?? [] as param (param.name)}
								{#if param.type === 'texture'}
									<!-- a div, not a label: the picker has its own around the file input -->
									<div class="shader-field">
										<span>{param.name}</span>
										<ShaderTexturePicker
											hash={selectedNode.data?.[param.name] ?? ''}
											onpick={(/** @type {string} */ next) => writeSelectedParam(param.name, next)}
										/>
									</div>
								{:else}
								<label class="shader-field">
									<span>{param.name}</span>
									{#if param.type === 'vec3' && typeof (selectedNode.data?.[param.name] ?? param.default) === 'string'}
										<input
											type="color"
											value={selectedNode.data?.[param.name] ?? param.default}
											oninput={(e) => writeSelectedParam(param.name, e.currentTarget.value)}
										/>
									{:else if param.type === 'vec2' || param.type === 'vec3' || param.type === 'vec4'}
										<ShaderVectorInput
											value={selectedNode.data?.[param.name] ?? param.default}
											size={param.type === 'vec2' ? 2 : param.type === 'vec4' ? 4 : 3}
											onchange={(/** @type {number[]} */ next) => writeSelectedParam(param.name, next)}
											onstart={() => beginShaderGesture(scope)}
											onend={() => endShaderGesture(scope)}
										/>
									{:else if param.type === 'float'}
										<DragRow
											step={0.005}
											decimals={3}
											value={selectedNode.data?.[param.name] ?? param.default}
											onscrubstart={() => beginShaderGesture(scope)}
											onscrubend={() => endShaderGesture(scope)}
											onchange={(/** @type {number} */ v) => writeSelectedParam(param.name, v)}
										/>
									{:else if param.type === 'enum'}
										<select
											value={selectedNode.data?.[param.name] ?? param.default}
											onchange={(e) => writeSelectedParam(param.name, e.currentTarget.value)}
										>
											{#each param.options ?? [] as option (option)}
												<option value={option}>{option}</option>
											{/each}
										</select>
									{:else}
										<input
											type="text"
											value={selectedNode.data?.[param.name] ?? param.default}
											onchange={(e) => writeSelectedParam(param.name, e.currentTarget.value)}
										/>
									{/if}
								</label>
								{/if}
							{/each}
							<p class="shader-hint">
								{(selectedDef.inputs ?? []).length} in · {(selectedDef.outputs ?? []).length} out
							</p>
							<!-- SH7: the generated UNIFORM NAMES, so a Set Shader Uniform flow node has
							     something to address. Without this the name is only discoverable by
							     reading the compiler's naming rule. -->
							{#if uniformNames.length}
								<p class="shader-hint">uniforms — paste into a Set Shader Uniform node:</p>
								{#each uniformNames as name (name)}
									<code class="shader-uniform-name">{name}</code>
								{/each}
							{/if}
						</div>
					{:else}
						<!-- no node selected: the GRAPH's own settings -->
						<div class="shader-props-body" id="shader-props-graph">
							<div class="shader-props-title">Graph</div>
							<label class="shader-field">
								<span>edges</span>
								<select bind:value={edgeStyle}>
									<option value="bezier">bezier</option>
									<option value="smoothstep">smoothstep</option>
									<option value="step">step</option>
									<option value="straight">straight</option>
								</select>
							</label>
							<label class="shader-field">
								<span>background</span>
								<select bind:value={bgPattern}>
									<option value="dots">dots</option>
									<option value="lines">lines</option>
									<option value="cross">cross</option>
								</select>
							</label>
							<label class="shader-field">
								<span>snap to grid</span>
								<input type="checkbox" bind:checked={snapToGrid} />
							</label>
							<label class="shader-field">
								<span>minimap</span>
								<input type="checkbox" bind:checked={showMinimap} />
							</label>
							{#if doc}
								<p class="shader-hint">
									{doc.nodes.length} nodes · {doc.edges.length} wires · {doc.backend}
								</p>
								<p class="shader-hint">Replicates to peers · saved with the scene</p>
							{:else}
								<p class="shader-hint">
									Select nothing for the scene shader, or one object for its own.
								</p>
							{/if}
						</div>
					{/if}
				</div>
			{/if}
		</div>
	</div>
{/if}

{#if menu}
	<ContextMenu
		x={menu.x}
		y={menu.y}
		items={menu.items}
		sizeKey="shader"
		on:close={() => (menu = null)}
	/>
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
		flex: 0 0 auto;
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
	.shader-body {
		flex: 1;
		min-height: 0;
		display: flex;
		/* docked panels shrink by the Controls HUD footprint on folded screens, so the
		   canvas is never hidden behind it (the --dock-inset contract) */
		padding-bottom: var(--dock-inset, 0px);
	}
	.shader-side {
		flex: 0 0 148px;
		overflow-y: auto;
		background: rgba(0, 0, 0, 0.18);
	}
	.shader-side-left {
		border-right: 1px solid rgba(255, 255, 255, 0.07);
		/* #20 P7: the tree is a fixed-height section and the palette scrolls under it,
		   so the COLUMN owns the layout and the palette owns the scrolling */
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}
	.shader-side-scroll {
		min-height: 0;
		flex: 1 1 auto;
		overflow-y: auto;
	}
	.shader-side-right {
		flex-basis: 172px;
		border-left: 1px solid rgba(255, 255, 255, 0.07);
	}
	.shader-divider {
		flex: 0 0 12px;
		background: rgba(255, 255, 255, 0.04);
		color: #9ca3af;
		font-size: 10px;
	}
	.shader-divider:hover {
		background: rgba(255, 255, 255, 0.1);
		color: #e5e7eb;
	}
	.shader-canvas {
		position: relative;
		flex: 1;
		min-width: 0;
	}
	.shader-errors {
		flex: 0 0 auto;
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
		gap: 10px;
		text-align: center;
		padding: 0 24px;
	}
	.shader-create {
		border-radius: 8px;
		background: var(--color-primary-700, #1d4ed8);
		padding: 8px 16px;
		font-size: 13px;
		font-weight: 500;
		color: #fff;
	}
	.shader-create:hover {
		background: var(--color-primary-600, #2563eb);
	}
	.shader-props-tabs {
		display: flex;
		gap: 2px;
		padding: 4px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.07);
	}
	.shader-props-tabs button {
		padding: 3px 7px;
		border-radius: 3px;
		color: #9ca3af;
	}
	.shader-props-tabs button.active {
		background: rgba(255, 255, 255, 0.1);
		color: #f3f4f6;
	}
	.shader-props-body {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 6px;
	}
	.shader-props-title {
		font-size: 11px;
		font-weight: 600;
		color: #e5e7eb;
	}
	.shader-field {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		font-size: 10px;
		color: #d1d5db;
	}
	.shader-field input[type='text'],
		.shader-field select {
		width: 88px;
		background: rgba(0, 0, 0, 0.35);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 3px;
		padding: 1px 3px;
		font-size: 10px;
		color: #f3f4f6;
	}
	.shader-field input[type='color'] {
		width: 34px;
		height: 18px;
		padding: 0;
		border: 1px solid rgba(255, 255, 255, 0.15);
		background: transparent;
	}
	.shader-hint {
		font-size: 9px;
		line-height: 1.35;
		color: #6b7280;
	}
	.shader-doc {
		font-size: 10px;
		line-height: 1.4;
		color: #cbd5e1;
		background: rgba(255, 255, 255, 0.04);
		border-left: 2px solid rgba(255, 255, 255, 0.18);
		border-radius: 0 3px 3px 0;
		padding: 4px 6px;
	}
	.shader-uniform-name {
		display: block;
		font-family: ui-monospace, monospace;
		font-size: 9px;
		color: #a5b4fc;
		background: rgba(0, 0, 0, 0.3);
		border-radius: 3px;
		padding: 1px 4px;
		/* selectable, so it can be copied: the graph canvas otherwise eats the drag */
		user-select: text;
		overflow-wrap: anywhere;
	}
</style>
