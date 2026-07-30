<script lang="ts">
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		MarkerType,
		useSvelteFlow,
		type Node,
		type Edge,
		type Connection
	} from '@xyflow/svelte';
	// 👇 this is important! You need to import the styles for Svelte Flow to work
	import '@xyflow/svelte/dist/style.css';
	import '../../styles/flow.css';
	import { writable, get } from 'svelte/store';
	import Sidebar from './Sidebar.svelte';
	import PeerCursors from './PeerCursors.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import ColorPickerNode from './nodes/ColorPickerNode.svelte';
	import SliderNode from './nodes/SliderNode.svelte';
	import SwitcherNode from './nodes/SwitcherNode.svelte';
	import ObjectSelectorNode from './nodes/ObjectSelectorNode.svelte';
	import AnimationNode from './nodes/AnimationNode.svelte';
	import ScriptNode from './nodes/ScriptNode.svelte';
	import MapRangeNode from './nodes/MapRangeNode.svelte';
	import SelectNode from './nodes/SelectNode.svelte';
	import CustomNode from './nodes/CustomNode.svelte';
	import PathPatrolNode from './nodes/PathPatrolNode.svelte';
	import SoundNode from './nodes/SoundNode.svelte';
	import ParticleNode from './nodes/ParticleNode.svelte';
	import NumberNode from './nodes/NumberNode.svelte';
	import Vector3Node from './nodes/Vector3Node.svelte';
	import ToggleNode from './nodes/ToggleNode.svelte';
	import RandomNode from './nodes/RandomNode.svelte';
	import TimeNode from './nodes/TimeNode.svelte';
	import BinaryNode from './nodes/BinaryNode.svelte';
	import LoopNode from './nodes/LoopNode.svelte';
	import TimerNode from './nodes/TimerNode.svelte';
	import ObjectPairNode from './nodes/ObjectPairNode.svelte';
	import EffectNode from './nodes/EffectNode.svelte';
	import OnClickNode from './nodes/OnClickNode.svelte';
	import CounterNode from './nodes/CounterNode.svelte';
	import FlowIONode from './nodes/FlowIONode.svelte';
	import ObjectFlowNode from './nodes/ObjectFlowNode.svelte';
	import KeyPressNode from './nodes/KeyPressNode.svelte';
	import { flowNodes as nodes, flowEdges as edges, customNodeDefs, nodeDesignerOpen, flowGraphs, activeGraphId, SCENE_GRAPH, setActiveGraph } from '../../stores/flowStore';
	import { createObjectGraph, requestDeleteObjectGraph } from '$lib/flowGraphs';
	import { deselectObject } from '$lib/objectActions';
	import { objectsGroup, selectedObject, selectedObjects } from '../../stores/sceneStore';
	import { serializeNode, serializeEdge, deleteFlowNodes, deleteFlowEdges, setNodeData } from '$lib/nodesHandler';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { defDefaults } from '$lib/customNodes';
	import { findNodeSpec, nodeCatalog } from '$lib/nodeCatalog';
	import { isValidFlowConnection, typeColor, replaceableInputEdges } from '$lib/flowSockets';
	import { moduleNodeGroups, moduleNodeComponents } from '$lib/moduleSDK';
	import { rightDragMove, inputContextMenu } from '$lib/searchMenuUx';
	import { peers, username } from '../../stores/appStore';

	// module node types default to the spec-driven AnimationNode unless the
	// module registered its own component
	const moduleTypes = Object.fromEntries(
		get(moduleNodeGroups)
			.flatMap((group) => group.items)
			.map((item) => [item.type, moduleNodeComponents[item.type] ?? AnimationNode])
	);
	const nodeTypes = {
		colorpicker: ColorPickerNode,
		slider: SliderNode,
		switcher: SwitcherNode,
		objectselector: ObjectSelectorNode,
		shake: AnimationNode,
		spin: AnimationNode,
		bounce: AnimationNode,
		orbit: AnimationNode,
		pulse: AnimationNode,
		blink: AnimationNode,
		script: ScriptNode,
		maprange: MapRangeNode,
		select: SelectNode,
		customnode: CustomNode,
		pathpatrol: PathPatrolNode,
		sound: SoundNode,
		particle: ParticleNode,
		mass: AnimationNode,
		bounciness: AnimationNode,
		friction: AnimationNode,
		angularvelocity: AnimationNode,
		motor: AnimationNode,
		number: NumberNode,
		vector3: Vector3Node,
		toggle: ToggleNode,
		random: RandomNode,
		time: TimeNode,
		math: BinaryNode,
		compare: BinaryNode,
		gate: BinaryNode,
		loop: LoopNode,
		timer: TimerNode,
		distance: ObjectPairNode,
		proximity: ObjectPairNode,
		lookat: EffectNode,
		setcolor: EffectNode,
		visibility: EffectNode,
		onclick: OnClickNode,
		onimpact: AnimationNode,
		counter: CounterNode,
		flowinput: FlowIONode,
		flowoutput: FlowIONode,
		objectflow: ObjectFlowNode,
		keypress: KeyPressNode,
		...moduleTypes
	};

	const { screenToFlowPosition, fitView, setViewport } = useSvelteFlow();

	// palette collapse + side (82), persisted. Exported so the docked host (Flow) can
	// inset its content above the Controls HUD only when the palette is actually shown.
	export let paletteOpen = typeof localStorage === 'undefined' || localStorage.getItem('flowPaletteOpen') !== 'false';
	let paletteSide = typeof localStorage !== 'undefined' ? localStorage.getItem('flowPaletteSide') ?? 'left' : 'left';

	// 166: flow PROPERTIES panel — curated graph prefs (LOCAL, persisted) + the
	// selected node's props. Right-side, collapses like the palette.
	const LS = typeof localStorage !== 'undefined' ? localStorage : null;
	let propsOpen = LS?.getItem('flowPropsOpen') === 'true';
	// 4.3: right-panel tab — 'info' (selected node's params) | 'settings' (graph + name/note)
	let propsTab = LS?.getItem('flowPropsTab') || 'settings';
	// 179: the properties panel auto-reflows to the side OPPOSITE the palette so
	// their divider tabs never overlap (the palette-side toggle used to hide it)
	$: propsSide = paletteSide === 'right' ? 'left' : 'right';
	let edgeStyle = LS?.getItem('flowEdgeStyle') ?? 'bezier';
	let showMinimap = LS?.getItem('flowMinimap') !== 'false';
	let bgPattern = LS?.getItem('flowBg') ?? 'dots';
	let gridSnapOn = LS?.getItem('flowGridSnap') !== 'false';
	let gridSize = +(LS?.getItem('flowGridSize') ?? '25');
	const BG_LINES = BackgroundVariant.Lines;
	const BG_DOTS = BackgroundVariant.Dots;
	$: snapGrid = [gridSnapOn ? gridSize : 1, gridSnapOn ? gridSize : 1] as [number, number];
	$: bgVariant = bgPattern === 'lines' ? BG_LINES : BG_DOTS;
	$: selectedNode = ($nodes as any[]).find((n) => n.selected) ?? null;

	// H1 (flow v2): the editor scope follows the viewport selection — a selected
	// object shows ITS graph (or the create-flow empty state), deselecting returns
	// to the scene graph. "Has a selection" MUST be read from the selectedObjects
	// SET: selectedObject keeps the last object after a deselect on purpose (the
	// inspector/outline bind to it), so an empty-space click clears only the set.
	$: {
		const set = $selectedObjects as string[];
		const primary = ($selectedObject as any)?.uuid;
		const scopeUuid = set.length ? (primary && set.includes(primary) ? primary : set[set.length - 1]) : null;
		setActiveGraph(scopeUuid ?? SCENE_GRAPH);
	}
	$: activeId = $activeGraphId;
	$: hasActiveGraph = activeId === SCENE_GRAPH || !!$flowGraphs[activeId];
	$: activeOwnerName =
		activeId === SCENE_GRAPH
			? 'Scene'
			: ($objectsGroup as any)?.getObjectByProperty?.('uuid', activeId)?.name ||
				($objectsGroup as any)?.getObjectByProperty?.('uuid', activeId)?.type ||
				activeId.slice(0, 8);

	function setEdgeStyle(style: string) {
		edgeStyle = style;
		LS?.setItem('flowEdgeStyle', style);
		// restyle existing edges locally (cosmetic — not in the graph hash, 166)
		edges.update((es: any[]) => es.map((e) => ({ ...e, type: style })));
	}

	// shared with <SvelteFlow> so peer cursors can be projected to screen space
	const viewport = writable({ x: 0, y: 0, zoom: 1 });

	// Stores are initialized with null, so their inferred type is unusable here
	let peer: any;
	$: peer = $peers;

	// broadcast the local cursor position in flow coordinates (throttled)
	let lastCursorSent = 0;
	const onPointerMoveCursor = (event: PointerEvent) => {
		if (!peer) return;
		const now = Date.now();
		if (now - lastCursorSent < 50) return;
		lastCursorSent = now;
		const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		peer.send({
			type: 'flowcursor',
			id: peer.peer.id,
			name: $username || peer.peer.id,
			x: position.x,
			y: position.y,
			graphId: activeId
		});
	};
	const onPointerLeaveCursor = () => {
		if (peer) peer.send({ type: 'flowcursor', id: peer.peer.id, leave: true });
	};

	// active context menu: { x, y, items }
	let menu: any = null;

	function addNode(type: string, label: string, position: { x: number; y: number }, extraDefaults: any = null) {
		// H1: adding a node to a selected object that has no flow yet CREATES the
		// flow implicitly (replicated + undoable) — the palette stays usable from
		// the empty state.
		if (activeId !== SCENE_GRAPH && !hasActiveGraph) createObjectGraph(activeId);
		const spec = findNodeSpec(type);
		const newNode = {
			id: crypto.randomUUID(),
			type,
			position,
			data: {
				label: label,
				type: type,
				...(spec?.defaults ?? {}),
				...(extraDefaults ?? {})
			},
			class: 'w-[150px]'
		} satisfies Node;

		nodes.update((nodes) => [...nodes, newNode]);
		// Replicate the new node to all peers
		peer?.send({ type: 'nodecreate', node: serializeNode(newNode), graphId: activeId });
	}

	// Touch has no HTML5 drag-and-drop, so a palette TAP adds the node at the flow
	// pane's centre (the node can then be dragged on the canvas, which touch supports).
	function addNodeAtCenter(type: string) {
		const pane = document.querySelector('.svelte-flow');
		const r = pane?.getBoundingClientRect();
		const cx = r ? r.left + r.width / 2 : window.innerWidth / 2;
		const cy = r ? r.top + r.height / 2 : window.innerHeight / 2;
		const position = screenToFlowPosition({ x: cx, y: cy });
		if (type.startsWith('customnode:')) {
			const def = $customNodeDefs.find((d) => d.id === type.slice('customnode:'.length));
			if (def) addNode('customnode', def.name, position, defDefaults(def));
			return;
		}
		addNode(type, findNodeSpec(type)?.label ?? `${type} node`, position);
	}

	// Touch drag-to-place: the palette (Sidebar) drags a ghost and drops it here at a
	// screen point; place the node there (mirrors onDrop, which touch can't trigger).
	function addNodeAtScreen(type: string, clientX: number, clientY: number) {
		const position = screenToFlowPosition({ x: clientX, y: clientY });
		if (type.startsWith('customnode:')) {
			const def = $customNodeDefs.find((d) => d.id === type.slice('customnode:'.length));
			if (def) addNode('customnode', def.name, position, defDefaults(def));
			return;
		}
		addNode(type, findNodeSpec(type)?.label ?? `${type} node`, position);
	}

	const onDragOver = (event: DragEvent) => {
		event.preventDefault();
		if (event.dataTransfer) {
			event.dataTransfer.dropEffect = 'move';
		}
	};

	const onDrop = (event: DragEvent) => {
		event.preventDefault();
		if (!event.dataTransfer) return;

		const type = event.dataTransfer.getData('application/svelteflow');
		if (!type) return;

		const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		// custom node defs are dragged as 'customnode:<defId>'
		if (type.startsWith('customnode:')) {
			const def = $customNodeDefs.find((d) => d.id === type.slice('customnode:'.length));
			if (def) addNode('customnode', def.name, position, defDefaults(def));
			return;
		}
		addNode(type, findNodeSpec(type)?.label ?? `${type} node`, position);
	};

	// Replicate node positions when a drag ends
	const onNodeDragStop = (event: CustomEvent<{ nodes: Node[] }>) => {
		event.detail.nodes.forEach((node) => {
			peer?.send({ type: 'nodemove', id: node.id, position: { x: node.position.x, y: node.position.y }, graphId: activeId });
		});
	};

	// 165: reject a drag between incompatible socket types (same type or a sane
	// coercion). Saved edges are not re-validated — only live drags.
	const isValidConnection = (connection: any) => isValidFlowConnection(connection, get(nodes));

	// Give new edges a deterministic id and replicate them to all peers.
	// 4.1: the id MUST include the handles — without them, wiring one source into
	// BOTH a and b of a node collided ids, the peer-side dedupe dropped edge #2
	// and the graphs diverged permanently (nodesync could never converge).
	const onedgecreate = (connection: Connection) => {
		// single-connection inputs: a new wire into an occupied VALUE input
		// replaces the old one (effect/event inputs keep multi fan-in; fan-out
		// from an output is always unlimited)
		const stale = replaceableInputEdges(connection, get(nodes), get(edges));
		if (stale.length) {
			deleteFlowEdges(stale, activeId);
			peer?.send({ type: 'edgedelete', ids: stale, graphId: activeId });
		}
		const edge = {
			id: `e-${connection.source}${connection.sourceHandle ? '.' + connection.sourceHandle : ''}-${connection.target}${connection.targetHandle ? '.' + connection.targetHandle : ''}`,
			source: connection.source,
			target: connection.target,
			sourceHandle: connection.sourceHandle,
			targetHandle: connection.targetHandle,
			// 69: readable edges — same shape on every peer via serializeEdge
			// 150/166: edge style follows the flow properties panel (local pref)
			type: edgeStyle,
			markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }
		} satisfies Edge;
		peer?.send({ type: 'edgecreate', edge: serializeEdge(edge), graphId: activeId });
		return edge;
	};

	// Replicate deletions (Backspace / Delete key)
	const ondelete = ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
		if (deletedNodes.length)
			peer?.send({ type: 'nodedelete', ids: deletedNodes.map((n) => n.id), graphId: activeId });
		if (deletedEdges.length)
			peer?.send({ type: 'edgedelete', ids: deletedEdges.map((e) => e.id), graphId: activeId });
	};

	// --- context menus ---

	function deleteNode(id: string) {
		deleteFlowNodes([id], activeId);
		peer?.send({ type: 'nodedelete', ids: [id], graphId: activeId });
	}

	function disconnectNode(id: string) {
		const ids = $edges.filter((e) => e.source === id || e.target === id).map((e) => e.id);
		if (ids.length) {
			deleteFlowEdges(ids, activeId);
			peer?.send({ type: 'edgedelete', ids: ids, graphId: activeId });
		}
	}

	function deleteEdge(id: string) {
		deleteFlowEdges([id], activeId);
		peer?.send({ type: 'edgedelete', ids: [id], graphId: activeId });
	}

	const onPaneContextMenu = (event: CustomEvent<{ event: MouseEvent }>) => {
		const e = event.detail.event;
		e.preventDefault();
		const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
		menu = {
			x: e.clientX,
			y: e.clientY,
			flowPos,
			items: [
				{ label: 'Search nodes…', action: () => openSearch('') },
				...[...nodeCatalog, ...$moduleNodeGroups].map((group) => ({
					label: group.group,
					children: group.items.map((item) => ({
						label: item.label,
						action: () => addNode(item.type, item.label, flowPos)
					}))
				})),
				{
					label: 'Custom',
					children: [
						...$customNodeDefs.map((def) => ({
							label: def.name,
							action: () => addNode('customnode', def.name, flowPos, defDefaults(def))
						})),
						{ label: 'New custom node…', action: () => nodeDesignerOpen.set('new') }
					]
				}
			]
		};
	};

	// 167: clone a node (fresh uuid, offset, same data) — edges are NOT copied
	function duplicateNode(id: string) {
		const src = get(nodes).find((n: any) => n.id === id);
		if (!src) return;
		const copy = {
			id: crypto.randomUUID(),
			type: src.type,
			position: { x: src.position.x + 30, y: src.position.y + 30 },
			data: { ...src.data },
			...(src.class ? { class: src.class } : {})
		} as any;
		nodes.update((ns: any[]) => [...ns, copy]);
		peer?.send({ type: 'nodecreate', node: serializeNode(copy), graphId: activeId });
	}

	const onNodeContextMenu = (event: CustomEvent<{ event: MouseEvent; node: Node }>) => {
		event.detail.event.preventDefault();
		const id = event.detail.node.id;
		menu = {
			x: event.detail.event.clientX,
			y: event.detail.event.clientY,
			items: [
				{ label: 'Duplicate', action: () => duplicateNode(id) },
				{ label: 'Disconnect all', action: () => disconnectNode(id) },
				{ label: 'Delete node', danger: true, action: () => deleteNode(id) }
			]
		};
	};

	const onEdgeContextMenu = (event: CustomEvent<{ event: MouseEvent; edge: Edge }>) => {
		event.detail.event.preventDefault();
		const id = event.detail.edge.id;
		menu = {
			x: event.detail.event.clientX,
			y: event.detail.event.clientY,
			items: [{ label: 'Disconnect', action: () => deleteEdge(id) }]
		};
	};

	// --- node search: a box that REPLACES the pane menu at the same spot/size ---
	let search: any = null; // {x, y, width, flowPos, query, highlight}
	let savedMenu: any = null;

	function openSearch(initial: string) {
		if (!menu?.flowPos) return;
		const menuEl = document.querySelector('[role="menu"]');
		const width = Math.max(menuEl?.getBoundingClientRect().width ?? 0, 240);
		savedMenu = menu;
		// clamp so the box (input + scrollable results, ~330px) stays on screen (91)
		const y = Math.max(8, Math.min(menu.y, window.innerHeight - 330));
		search = { x: menu.x, y, width, flowPos: menu.flowPos, query: initial, highlight: 0 };
		menu = null;
	}

	/** every addable node as a flat searchable entry */
	function searchEntries() {
		const entries: any[] = [];
		for (const group of [...nodeCatalog, ...$moduleNodeGroups])
			for (const item of group.items)
				entries.push({
					group: group.group,
					label: item.label,
					add: (pos: any) => addNode(item.type, item.label, pos)
				});
		for (const def of $customNodeDefs)
			entries.push({
				group: 'Custom',
				label: def.name,
				add: (pos: any) => addNode('customnode', def.name, pos, defDefaults(def))
			});
		return entries;
	}

	function subsequence(text: string, query: string) {
		let i = 0;
		for (const ch of text) if (ch === query[i]) i++;
		return i >= query.length;
	}

	function searchResults(query: string) {
		const entries = searchEntries();
		const q = query.trim().toLowerCase();
		// empty query = browse everything, scrolling (viewport Add search parity, 103)
		if (!q) return entries;
		return entries
			.map((entry) => {
				const text = (entry.label + ' ' + entry.group).toLowerCase();
				const rank = text.startsWith(q) ? 0 : text.includes(q) ? 1 : subsequence(text, q) ? 2 : 3;
				return [rank, entry] as [number, any];
			})
			.filter(([rank]) => rank < 3)
			.sort((a, b) => a[0] - b[0] || a[1].label.localeCompare(b[1].label))
			.map(([, entry]) => entry)
			.slice(0, 30); // the list scrolls now (84)
	}

	$: results = search ? searchResults(search.query) : [];

	function pickResult(entry: any) {
		entry.add(search.flowPos);
		search = null;
		savedMenu = null;
	}

	function scrollHighlightIntoView() {
		requestAnimationFrame(() =>
			document
				.querySelector('#node-search-box [data-selected="true"]')
				?.scrollIntoView({ block: 'nearest' })
		);
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'ArrowDown') {
			search = { ...search, highlight: Math.min(search.highlight + 1, results.length - 1) };
			scrollHighlightIntoView();
			event.preventDefault();
		} else if (event.key === 'ArrowUp') {
			search = { ...search, highlight: Math.max(search.highlight - 1, 0) };
			scrollHighlightIntoView();
			event.preventDefault();
		} else if (event.key === 'Enter') {
			if (results[search.highlight]) pickResult(results[search.highlight]);
			event.preventDefault();
		} else if (event.key === 'Escape') {
			menu = savedMenu; // back to the classic grouped menu
			search = null;
			event.preventDefault();
			event.stopPropagation();
		}
	}

	// typing while the pane menu is open jumps straight into search
	function onWindowKeydown(event: KeyboardEvent) {
		if (!menu?.flowPos || search) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		if (event.key.length !== 1) return;
		openSearch(event.key);
		event.preventDefault();
	}

	function focusInput(node: HTMLInputElement) {
		node.focus();
		node.setSelectionRange(node.value.length, node.value.length);
	}
</script>

<svelte:window on:keydown={onWindowKeydown} />

<div class="flex h-full w-full">
	{#if paletteOpen}
		<div class="h-full w-40 shrink-0 overflow-y-auto" style="order: {paletteSide === 'right' ? 3 : 1}">
			<Sidebar onPick={addNodeAtCenter} onPlaceAt={addNodeAtScreen} />
		</div>
	{/if}
	<!-- palette collapse/side controls: notebook-tab buttons on the divider (82) -->
	<div class="relative z-10 w-0" style="order: 2">
		<button
			id="palette-toggle"
			class="palette-tab {paletteSide === 'right' ? 'palette-tab-mirrored' : ''} absolute top-8 flex h-14 w-4 items-center justify-center bg-gray-700 text-[10px] text-gray-200 hover:bg-gray-600"
			style="{paletteSide === 'right' ? 'right' : 'left'}: -1px"
			title={paletteOpen ? 'Hide the node palette' : 'Show the node palette'}
			on:click={() => {
				paletteOpen = !paletteOpen;
				localStorage.setItem('flowPaletteOpen', String(paletteOpen));
			}}
		>
			{paletteOpen ? (paletteSide === 'right' ? '▸' : '◂') : paletteSide === 'right' ? '◂' : '▸'}
		</button>
		<button
			id="palette-side"
			class="palette-tab {paletteSide === 'right' ? 'palette-tab-mirrored' : ''} absolute top-24 flex h-9 w-4 items-center justify-center bg-gray-700 text-[9px] text-gray-300 hover:bg-gray-600"
			style="{paletteSide === 'right' ? 'right' : 'left'}: -1px"
			title="Move the palette to the other side"
			on:click={() => {
				paletteSide = paletteSide === 'right' ? 'left' : 'right';
				localStorage.setItem('flowPaletteSide', paletteSide);
			}}
		>
			⇄
		</button>
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="svelteFlow relative h-full grow"
		style="order: {paletteSide === 'right' ? 1 : 3}"
		on:pointermove={onPointerMoveCursor}
		on:pointerleave={onPointerLeaveCursor}
	>
		<!-- H1: graph-scope chip — which flow the editor shows (follows the viewport
		     selection). Object flows get a delete action (confirmation toast). -->
		<div
			id="flow-scope-chip"
			class="pointer-events-none absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5"
		>
			{#if activeId !== SCENE_GRAPH}
				<!-- explicit way back: show the Scene flow AND deselect the object -->
				<button
					id="flow-scope-scene"
					class="pointer-events-auto rounded-full border border-gray-700/60 bg-gray-800/85 px-2 py-0.5 text-xs text-gray-400 backdrop-blur hover:text-gray-100"
					title="Back to the Scene flow (deselects the object)"
					on:click={() => deselectObject()}
				>
					⌂ Scene
				</button>
			{/if}
			<span
				class="pointer-events-auto rounded-full border border-gray-700/60 bg-gray-800/85 px-2.5 py-0.5 text-xs text-gray-200 backdrop-blur"
			>
				{activeId === SCENE_GRAPH ? 'Scene flow' : activeOwnerName + ' — object flow'}
			</span>
			{#if activeId !== SCENE_GRAPH && hasActiveGraph}
				<button
					id="flow-scope-delete"
					class="pointer-events-auto rounded-full border border-gray-700/60 bg-gray-800/85 px-2 py-0.5 text-xs text-gray-400 backdrop-blur hover:text-red-400"
					title="Delete this object's flow"
					on:click={() => requestDeleteObjectGraph(activeId, activeOwnerName)}
				>
					<i class="fa-solid fa-trash-can"></i>
				</button>
			{/if}
		</div>

		<!-- H1: empty state — the selected object has no flow document yet -->
		{#if activeId !== SCENE_GRAPH && !hasActiveGraph}
			<div
				id="flow-empty-state"
				class="absolute inset-0 z-[5] flex flex-col items-center justify-center gap-3 bg-gray-900/60 backdrop-blur-[2px]"
			>
				<p class="text-sm text-gray-300">
					<span class="font-semibold text-gray-100">{activeOwnerName}</span> has no flow yet
				</p>
				<button
					id="flow-create-btn"
					class="rounded-lg bg-primary-700 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600"
					on:click={() => createObjectGraph(activeId)}
				>
					Create flow
				</button>
				<p class="text-[11px] text-gray-500">Nodes here will drive this object (no Object Selector needed)</p>
			</div>
		{/if}
		<SvelteFlow
			{nodes}
			{nodeTypes}
			{edges}
			{snapGrid}
			{viewport}
			{onedgecreate}
			{ondelete}
			{isValidConnection}
			defaultEdgeOptions={{ type: edgeStyle, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } }}
			deleteKey={['Backspace', 'Delete']}
			fitView
			maxZoom={1}
			minZoom={0.5}
			on:dragover={onDragOver}
			on:drop={onDrop}
			on:nodedragstop={onNodeDragStop}
			on:panecontextmenu={onPaneContextMenu}
			on:nodecontextmenu={onNodeContextMenu}
			on:edgecontextmenu={onEdgeContextMenu}
			on:paneclick={() => (menu = null)}
		>
			{#if bgPattern !== 'none'}
				<!-- 180: {#key} forces a remount so a dots<->lines switch applies at
				     once (xyflow ignores a live variant change); softer low-alpha
				     colour so the grid stops reading like a high-contrast notebook -->
				{#key bgPattern}
					<Background bgColor="transparent" variant={bgVariant} lineWidth={0.6} patternColor="rgba(128,128,128,0.18)" />
				{/key}
			{/if}
			<Controls showLock={false} />
			{#if showMinimap}
				<MiniMap
					pannable
					zoomable
					width={140}
					height={90}
					nodeColor={() => '#475569'}
					maskColor="rgb(17 24 39 / 0.65)"
				/>
			{/if}
		</SvelteFlow>
		<PeerCursors {viewport} />
	</div>
	<!-- 166/179: flow PROPERTIES panel, auto-reflowed opposite the palette -->
	<div class="relative z-10 w-0" style="order: {propsSide === 'left' ? 0 : 4}">
		<button
			id="flow-props-toggle"
			class="palette-tab {propsSide === 'left' ? '' : 'palette-tab-mirrored'} absolute top-8 flex h-14 w-4 items-center justify-center bg-gray-700 text-xs text-gray-200 hover:bg-gray-600"
			style="{propsSide === 'left' ? 'left' : 'right'}: -1px"
			title={propsOpen ? 'Hide properties' : 'Show properties'}
			on:click={() => { propsOpen = !propsOpen; LS?.setItem('flowPropsOpen', String(propsOpen)); }}
		>
			⚙
		</button>
	</div>
	{#if propsOpen}
		<div id="flow-props" class="flex h-full w-52 shrink-0 flex-col gap-2 overflow-y-auto bg-gray-800 p-2 text-xs text-gray-200" style="order: {propsSide === 'left' ? -1 : 5}">
			<!-- 4.3: Explorer-style tabs — ⓘ = the selected node's PARAMETERS,
			     ⚙ = graph settings + node name/note (as before) -->
			<div class="flex gap-1">
				<button id="flow-tab-info" class="flex-1 rounded px-2 py-1 {propsTab === 'info' ? 'bg-primary-700 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					on:click={() => { propsTab = 'info'; LS?.setItem('flowPropsTab', 'info'); }}>ⓘ Params</button>
				<button id="flow-tab-settings" class="flex-1 rounded px-2 py-1 {propsTab === 'settings' ? 'bg-primary-700 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					on:click={() => { propsTab = 'settings'; LS?.setItem('flowPropsTab', 'settings'); }}>⚙ Settings</button>
			</div>
			{#if propsTab === 'info'}
				{#if selectedNode}
					<p class="ui-section-label">{selectedNode.data?.label ?? selectedNode.type}</p>
					{#if selectedNode.type === 'slider'}
						<label class="flex items-center justify-between gap-2">Min
							<input id="param-slider-min" class="ui-input w-16" type="number" value={selectedNode.data?.min ?? 0}
								on:change={(e) => setNodeData(selectedNode.id, { min: +e.currentTarget.value || 0 })} /></label>
						<label class="flex items-center justify-between gap-2">Max
							<input id="param-slider-max" class="ui-input w-16" type="number" value={selectedNode.data?.max ?? 40}
								on:change={(e) => setNodeData(selectedNode.id, { max: +e.currentTarget.value || 0 })} /></label>
					{:else if selectedNode.type === 'switcher'}
						{#each selectedNode.data?.items ?? ['cube', 'pyramid'] as item, i}
							<div class="flex items-center gap-1">
								<input class="ui-input flex-1" value={item}
									on:change={(e) => {
										const items = [...(selectedNode.data?.items ?? ['cube', 'pyramid'])];
										items[i] = e.currentTarget.value;
										setNodeData(selectedNode.id, { items });
									}} />
								<button class="rounded bg-gray-600 px-1.5 hover:bg-red-700" title="Remove item"
									on:click={() => {
										const items = (selectedNode.data?.items ?? ['cube', 'pyramid']).filter((_: any, x: number) => x !== i);
										if (items.length) setNodeData(selectedNode.id, { items, index: 0, shape: items[0] });
									}}>✕</button>
							</div>
						{/each}
						<button id="param-switcher-add" class="rounded bg-gray-600 px-2 py-1 hover:bg-gray-500"
							on:click={() => {
								const items = [...(selectedNode.data?.items ?? ['cube', 'pyramid']), 'item ' + ((selectedNode.data?.items?.length ?? 2) + 1)];
								setNodeData(selectedNode.id, { items });
							}}>＋ Add item</button>
					{:else if selectedNode.type === 'number'}
						<label class="flex items-center justify-between gap-2">Step
							<input id="param-number-step" class="ui-input w-16" type="number" min="0" value={selectedNode.data?.step ?? 1}
								on:change={(e) => setNodeData(selectedNode.id, { step: +e.currentTarget.value || 1 })} /></label>
					{:else}
						<p class="text-gray-400">This node's parameters live on its card.</p>
					{/if}
				{:else}
					<p class="text-gray-400">Select a node to edit its parameters.</p>
				{/if}
			{:else}
			{#if selectedNode}
				<p class="ui-section-label">Node</p>
				<label class="flex flex-col gap-1">Name
					<input id="flow-node-name" class="ui-input" value={selectedNode.data?.label ?? ''}
						on:change={(e) => setNodeData(selectedNode.id, { label: e.currentTarget.value })} /></label>
				<label class="flex flex-col gap-1">Note
					<textarea class="ui-input" rows="2" value={selectedNode.data?.note ?? ''}
						on:change={(e) => setNodeData(selectedNode.id, { note: e.currentTarget.value })}></textarea></label>
			{:else}
				<p class="ui-section-label">Graph</p>
				<label class="flex flex-col gap-1">Edge style
					<ThemedSelect
						id="flow-edge-style"
						items={[{ value: 'bezier', name: 'Bezier' }, { value: 'smoothstep', name: 'Step' }, { value: 'straight', name: 'Straight' }]}
						value={edgeStyle}
						onchange={(v) => setEdgeStyle(v)} /></label>
				<label class="flex flex-col gap-1">Background
					<ThemedSelect
						id="flow-bg-pattern"
						items={[{ value: 'dots', name: 'Dots' }, { value: 'lines', name: 'Lines' }, { value: 'none', name: 'None' }]}
						value={bgPattern}
						onchange={(v) => { bgPattern = v; LS?.setItem('flowBg', v); }} /></label>
				<label class="flex items-center gap-2">
					<input id="flow-minimap-toggle" type="checkbox" checked={showMinimap}
						on:change={(e) => { showMinimap = e.currentTarget.checked; LS?.setItem('flowMinimap', String(showMinimap)); }} /> Minimap</label>
				<label class="flex items-center gap-2">
					<input type="checkbox" checked={gridSnapOn}
						on:change={(e) => { gridSnapOn = e.currentTarget.checked; LS?.setItem('flowGridSnap', String(gridSnapOn)); }} /> Snap to grid</label>
				<label class="flex items-center gap-2">Grid size
					<input class="ui-input w-16" type="number" min="1" value={gridSize}
						on:change={(e) => { gridSize = +e.currentTarget.value || 25; LS?.setItem('flowGridSize', String(gridSize)); }} /></label>
				<div class="mt-1 flex gap-1">
					<button id="flow-fit" class="rounded bg-gray-600 px-2 py-1 hover:bg-gray-500" on:click={() => fitView()}>Fit</button>
					<button id="flow-reset-view" class="rounded bg-gray-600 px-2 py-1 hover:bg-gray-500" on:click={() => setViewport({ x: 0, y: 0, zoom: 1 })}>Reset view</button>
				</div>
				<!-- B4.2: socket type -> color legend (sockets are painted by TYPE now) -->
				<p class="ui-section-label mt-1">Socket types</p>
				<div id="socket-legend" class="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-gray-300">
					{#each ['number', 'vector3', 'boolean', 'color', 'object', 'event', 'effect'] as t}
						<span class="flex items-center gap-1">
							<span class="inline-block h-2 w-2 rounded-full" style="background: {typeColor(t)}"></span>{t}
						</span>
					{/each}
				</div>
			{/if}
			{/if}
		</div>
	{/if}
</div>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} on:close={() => (menu = null)} />
{/if}

{#if search}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0"
		style="z-index: 999;"
		role="presentation"
		on:click={() => {
			search = null;
			savedMenu = null;
		}}
	></div>
	<div
		id="node-search-box"
		class="fixed rounded-lg border border-gray-200 bg-white py-1 text-xs shadow-lg dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
		style="left: {search.x}px; top: {search.y}px; width: {search.width}px; z-index: 1000;"
		use:rightDragMove={{ onMove: (dx, dy) => (search = { ...search, x: Math.max(0, search.x + dx), y: Math.max(0, search.y + dy) }) }}
	>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="node-search-input"
			use:focusInput
			use:inputContextMenu
			class="mx-2 mb-1 w-[calc(100%-16px)] rounded border border-gray-300 bg-transparent px-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary-500 dark:border-gray-500"
			placeholder="Search nodes… (Esc = menu)"
			value={search.query}
			on:input={(e) => (search = { ...search, query: e.currentTarget.value, highlight: 0 })}
			on:keydown={onSearchKeydown}
		/>
		<div class="max-h-64 overflow-y-auto">
			{#each results as entry, index}
				<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
				<div
					class="cursor-pointer px-3 py-1.5 {index === search.highlight
						? 'bg-primary-600 text-white'
						: 'hover:bg-gray-100 dark:hover:bg-gray-600'}"
					data-selected={index === search.highlight}
					on:mouseenter={() => (search = { ...search, highlight: index })}
					on:click={() => pickResult(entry)}
				>
					<span class={index === search.highlight ? 'text-white/70' : 'text-gray-400'}>{entry.group} · </span>{entry.label}
				</div>
			{/each}
			{#if results.length === 0}
				<div class="px-3 py-1.5 text-gray-400">No matches</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	:global(.svelte-flow) {
		background-color: transparent !important;
	}
	:global(.svelte-flow__attribution) {
		display: none;
	}
</style>
