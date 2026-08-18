<script lang="ts">
	import { untrack } from 'svelte';
	import { Trash2 } from '@lucide/svelte';
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
	import { get } from 'svelte/store';
	import Sidebar from './Sidebar.svelte';
	import GraphTree from './GraphTree.svelte';
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
	import ColliderNode from './nodes/ColliderNode.svelte';
	import VelocityNode from './nodes/VelocityNode.svelte';
	import CounterNode from './nodes/CounterNode.svelte';
	import FlowIONode from './nodes/FlowIONode.svelte';
	import ObjectFlowNode from './nodes/ObjectFlowNode.svelte';
	import KeyPressNode from './nodes/KeyPressNode.svelte';
	import PlayAnimNode from './nodes/PlayAnimNode.svelte';
	import AnimStateNode from './nodes/AnimStateNode.svelte';
	import UnknownNode from './nodes/UnknownNode.svelte';
	import { flowNodes as flowNodesStore, flowEdges as flowEdgesStore, customNodeDefs, nodeDesignerOpen, flowGraphs, activeGraphId, SCENE_GRAPH, setActiveGraph } from '../../stores/flowStore';
	import { createObjectGraph, requestDeleteObjectGraph } from '$lib/flowGraphs';
	import { deselectObject } from '$lib/objectActions';
	import { objectsGroup, selectedObject, selectedObjects } from '../../stores/sceneStore';
	import { serializeNode, serializeEdge, deleteFlowNodes, deleteFlowEdges, setNodeData } from '$lib/nodesHandler';
	import ThemedSelect from '../ui/ThemedSelect.svelte';
	import { defDefaults } from '$lib/customNodes';
	import { findNodeSpec, nodeCatalog } from '$lib/nodeCatalog';
	import { isValidFlowConnection, typeColor, replaceableInputEdges } from '$lib/flowSockets';
	import { moduleNodeGroups, moduleNodeComponents } from '$lib/moduleSDK';
	import { peers, username, modulesOpen } from '../../stores/appStore';
	// A6.4: ONE rewrite fixes three bugs that lived in this map.
	//
	// (1) It was `get(moduleNodeGroups)` — a NON-REACTIVE init-time read, so a module
	//     installed after the Flow dock mounted rendered as xyflow's bare default
	//     card. That broke the GOOD case, and it is exactly what a game template
	//     does: install the module, then load the scene.
	// (2) Module types were spread LAST, so a module could silently SHADOW a core
	//     node type. Core wins now, and a collision warns instead of vanishing.
	// (3) A type nothing defines got xyflow's default card with no explanation.
	//     UnknownNode says what is missing and offers to install it.
	const CORE_NODE_TYPES: any = {
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
		setuniform: EffectNode,
		onclick: OnClickNode,
		onimpact: AnimationNode,
		onenter: OnClickNode, // CL-C: same pulse card, sensor copy
		onexit: OnClickNode,
		collider: ColliderNode, // CL-C
		velocity: VelocityNode, // CL-C
		counter: CounterNode,
		flowinput: FlowIONode,
		flowoutput: FlowIONode,
		objectflow: ObjectFlowNode,
		keypress: KeyPressNode,
		playanim: PlayAnimNode, // 17-E A5
		animfinished: OnClickNode, // 17-E: a pulse when a clip ends
		animmarker: OnClickNode, // 17-E F5: a pulse at a named point in a clip
		animstate: AnimStateNode // 17-E F3: the readable half of it
	};

	// module node types default to the spec-driven AnimationNode unless the
	// module registered its own component
	const moduleTypes = $derived(
		Object.fromEntries(
			$moduleNodeGroups
				.flatMap((group) => group.items)
				.map((item) => [item.type, moduleNodeComponents[item.type] ?? AnimationNode])
		)
	);
	// a module type that collides with a core one loses — and says so, because the
	// old silent shadowing left the core node unreachable with no clue why
	$effect(() => {
		const clash = Object.keys(moduleTypes).filter((type) => type in CORE_NODE_TYPES);
		if (clash.length)
			console.log('module node type(s) shadow core types and were ignored:', clash.join(', '));
	});

	// every type present in ANY graph document that nothing can render
	const unknownTypes = $derived(
		[...new Set($flowGraphs ? Object.values($flowGraphs).flatMap((g: any) => (g.nodes ?? []).map((n: any) => n.type)) : [])]
			.filter((type): type is string => !!type && !(type in CORE_NODE_TYPES) && !(type in moduleTypes))
	);
	const nodeTypes: any = $derived({
		...moduleTypes,
		...CORE_NODE_TYPES,
		...Object.fromEntries(unknownTypes.map((type) => [type, UnknownNode]))
	});
	// how many nodes of the VISIBLE graph are unrenderable (the topbar badge)
	const unknownHere = $derived(
		($flowNodesStore as any[]).filter((node) => unknownTypes.includes(node.type)).length
	);
	// what the map resolved to at MOUNT — kept only so a suite can compute the
	// counterfactual of the reactivity fix (see the debug hook below). Capturing the
	// initial value is the WHOLE POINT here, so the warning is silenced deliberately.
	// svelte-ignore state_referenced_locally
	const mountedTypes: string[] = Object.keys(nodeTypes);

	const { screenToFlowPosition, fitView, setViewport } = useSvelteFlow();

	// e2e hook (debugStores opt-in), the Outline/CameraPreview pattern: the pane's
	// viewport belongs to xyflow, not to any store, and `fitView` runs at MOUNT — so a
	// suite that seeds nodes afterwards has no way to know, or choose, where they
	// landed on screen. Measured while building node-drag-fields: the mount fit left a
	// card at x = -29.5 (off the pane) at zoom 0.5, and a real pane drag panned by
	// 3775px for a 200px gesture. A test that needs to press a field needs this.
	$effect(() => {
		if (typeof window === 'undefined' || typeof localStorage === 'undefined') return;
		if (localStorage.getItem('debugStores') !== 'true') return;
		// TS syntax, not a JSDoc cast: this file is lang="ts", where JSDoc @type is IGNORED
		(window as any).__flowViewport = { setViewport, fitView };
		// A6.4: which types this MOUNTED pane can actually render, plus the snapshot it
		// resolved at mount. A suite proves the reactivity fix by comparing the two:
		// with the old non-reactive `get(moduleNodeGroups)` read they were identical,
		// so a module installed after the dock opened rendered as xyflow's bare card.
		(window as any).__flowNodeTypes = {
			live: () => Object.keys(nodeTypes),
			atMount: mountedTypes,
			unknown: () => [...unknownTypes],
			unknownHere: () => unknownHere
		};
		return () => {
			delete (window as any).__flowViewport;
			delete (window as any).__flowNodeTypes;
		};
	});

	// palette collapse + side (82), persisted. Exported so the docked host (Flow) can
	// inset its content above the Controls HUD only when the palette is actually shown.
	let {
		paletteOpen = $bindable(
			typeof localStorage === 'undefined' || localStorage.getItem('flowPaletteOpen') !== 'false'
		)
	}: { paletteOpen?: boolean } = $props();
	let paletteSide = $state(typeof localStorage !== 'undefined' ? localStorage.getItem('flowPaletteSide') ?? 'left' : 'left');
	// #20 P7: the left column's own height, measured — the graph tree's resize ceiling
	let paletteColH = $state(0);

	// --- xyflow v1 bridge -------------------------------------------------------
	// SvelteFlow 1.x binds PLAIN $state.raw arrays (immutable-style updates), not
	// writable stores. The flowNodes/flowEdges stores REMAIN the contract for all
	// lib code (nodesHandler appliers, history, flowRuntime, FlowCode...); these
	// locals mirror the ACTIVE graph's view store both ways.
	let nodes = $state.raw<Node[]>([]);
	let edges = $state.raw<Edge[]>([]);
	let pushingToStore = false;
	// store -> local (remote edits, undo, graph switches). The subscribe callback
	// fires synchronously and reads `nodes`/`edges`, so it runs inside untrack()
	// or the effect would re-run (and resubscribe) on every local change.
	$effect(() =>
		untrack(() =>
			flowNodesStore.subscribe((v: any[]) => {
				if (pushingToStore) return;
				if (v !== nodes) nodes = v as Node[];
			})
		)
	);
	$effect(() =>
		untrack(() =>
			flowEdgesStore.subscribe((v: any[]) => {
				if (pushingToStore) return;
				if (v !== edges) edges = v as Edge[];
			})
		)
	);
	// local -> store (drag positions, selection, connects made by SvelteFlow)
	$effect(() => {
		const local = nodes; // track
		untrack(() => {
			if (local !== get(flowNodesStore)) {
				pushingToStore = true;
				flowNodesStore.set(local);
				pushingToStore = false;
			}
		});
	});
	$effect(() => {
		const local = edges; // track
		untrack(() => {
			if (local !== get(flowEdgesStore)) {
				pushingToStore = true;
				flowEdgesStore.set(local);
				pushingToStore = false;
			}
		});
	});

	// 166: flow PROPERTIES panel — curated graph prefs (LOCAL, persisted) + the
	// selected node's props. Right-side, collapses like the palette.
	const LS = typeof localStorage !== 'undefined' ? localStorage : null;
	let propsOpen = $state(LS?.getItem('flowPropsOpen') === 'true');
	// 4.3: right-panel tab — 'info' (selected node's params) | 'settings' (graph + name/note)
	let propsTab = $state(LS?.getItem('flowPropsTab') || 'settings');
	// 179: the properties panel auto-reflows to the side OPPOSITE the palette so
	// their divider tabs never overlap (the palette-side toggle used to hide it)
	const propsSide = $derived(paletteSide === 'right' ? 'left' : 'right');
	let edgeStyle = $state(LS?.getItem('flowEdgeStyle') ?? 'bezier');
	let showMinimap = $state(LS?.getItem('flowMinimap') !== 'false');
	let bgPattern = $state(LS?.getItem('flowBg') ?? 'dots');
	let gridSnapOn = $state(LS?.getItem('flowGridSnap') !== 'false');
	let gridSize = $state(+(LS?.getItem('flowGridSize') ?? '25'));
	const BG_LINES = BackgroundVariant.Lines;
	const BG_DOTS = BackgroundVariant.Dots;
	const snapGrid = $derived([gridSnapOn ? gridSize : 1, gridSnapOn ? gridSize : 1] as [number, number]);
	const bgVariant = $derived(bgPattern === 'lines' ? BG_LINES : BG_DOTS);
	const selectedNode = $derived((nodes as any[]).find((n) => n.selected) ?? null);

	// H1 (flow v2): the editor scope follows the viewport selection — a selected
	// object shows ITS graph (or the create-flow empty state), deselecting returns
	// to the scene graph. "Has a selection" MUST be read from the selectedObjects
	// SET: selectedObject keeps the last object after a deselect on purpose (the
	// inspector/outline bind to it), so an empty-space click clears only the set.
	$effect(() => {
		const set = $selectedObjects as string[];
		const primary = ($selectedObject as any)?.uuid;
		const scopeUuid = set.length ? (primary && set.includes(primary) ? primary : set[set.length - 1]) : null;
		untrack(() => setActiveGraph(scopeUuid ?? SCENE_GRAPH));
	});
	const activeId = $derived($activeGraphId);
	const hasActiveGraph = $derived(activeId === SCENE_GRAPH || !!$flowGraphs[activeId]);
	const activeOwnerName = $derived(
		activeId === SCENE_GRAPH
			? 'Scene'
			: ($objectsGroup as any)?.getObjectByProperty?.('uuid', activeId)?.name ||
				($objectsGroup as any)?.getObjectByProperty?.('uuid', activeId)?.type ||
				activeId.slice(0, 8)
	);

	function setEdgeStyle(style: string) {
		edgeStyle = style;
		LS?.setItem('flowEdgeStyle', style);
		// restyle existing edges locally (cosmetic — not in the graph hash, 166)
		edges = (edges as any[]).map((e) => ({ ...e, type: style })) as Edge[];
	}

	// shared with <SvelteFlow> (bind:viewport) so peer cursors can be projected
	// to screen space — v1 binds a plain object, not a store
	let viewport = $state.raw({ x: 0, y: 0, zoom: 1 });

	// Stores are initialized with null, so their inferred type is unusable here
	const peer: any = $derived($peers);

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
	let menu: any = $state(null);

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

		nodes = [...nodes, newNode];
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

	// Replicate node positions when a drag ends (v1 payload: plain object)
	const onNodeDragStop = ({ nodes: dragged }: { targetNode: Node | null; nodes: Node[]; event: MouseEvent | TouchEvent }) => {
		dragged.forEach((node) => {
			peer?.send({ type: 'nodemove', id: node.id, position: { x: node.position.x, y: node.position.y }, graphId: activeId });
		});
	};

	// 165: reject a drag between incompatible socket types (same type or a sane
	// coercion). Saved edges are not re-validated — only live drags.
	const isValidConnection = (connection: any) => isValidFlowConnection(connection, nodes);

	// Give new edges a deterministic id and replicate them to all peers.
	// 4.1: the id MUST include the handles — without them, wiring one source into
	// BOTH a and b of a node collided ids, the peer-side dedupe dropped edge #2
	// and the graphs diverged permanently (nodesync could never converge).
	// v1: onbeforeconnect replaces v0's onedgecreate (same return-the-edge contract).
	const onbeforeconnect = (connection: Connection) => {
		// single-connection inputs: a new wire into an occupied VALUE input
		// replaces the old one (effect/event inputs keep multi fan-in; fan-out
		// from an output is always unlimited)
		const stale = replaceableInputEdges(connection, nodes, edges);
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
		const ids = (edges as any[]).filter((e) => e.source === id || e.target === id).map((e) => e.id);
		if (ids.length) {
			deleteFlowEdges(ids, activeId);
			peer?.send({ type: 'edgedelete', ids: ids, graphId: activeId });
		}
	}

	function deleteEdge(id: string) {
		deleteFlowEdges([id], activeId);
		peer?.send({ type: 'edgedelete', ids: [id], graphId: activeId });
	}

	const onPaneContextMenu = ({ event }: { event: MouseEvent }) => {
		event.preventDefault();
		const flowPos = screenToFlowPosition({ x: event.clientX, y: event.clientY });
		menu = {
			x: event.clientX,
			y: event.clientY,
			flowPos,
			items: [
				// 16-P2: the pane menu no longer carries its own search POPUP — this row
				// reveals the shared context-menu filter, which flattens every group as
				// "Group ▸ Node" with the same ranking as everywhere else. Typing
				// anywhere in the menu does the same thing (the filter input is always
				// focused), so this row is just the discoverable way in.
				{ label: 'Search nodes…', revealFilter: true },
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
		const src = (nodes as any[]).find((n) => n.id === id);
		if (!src) return;
		const copy = {
			id: crypto.randomUUID(),
			type: src.type,
			position: { x: src.position.x + 30, y: src.position.y + 30 },
			data: { ...src.data },
			...(src.class ? { class: src.class } : {})
		} as any;
		nodes = [...nodes, copy];
		peer?.send({ type: 'nodecreate', node: serializeNode(copy), graphId: activeId });
	}

	const onNodeContextMenu = ({ node, event }: { node: Node; event: MouseEvent }) => {
		event.preventDefault();
		const id = node.id;
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [
				{ label: 'Duplicate', action: () => duplicateNode(id) },
				{ label: 'Disconnect all', action: () => disconnectNode(id) },
				{ label: 'Delete node', danger: true, action: () => deleteNode(id) }
			]
		};
	};

	const onEdgeContextMenu = ({ edge, event }: { edge: Edge; event: MouseEvent }) => {
		event.preventDefault();
		const id = edge.id;
		menu = {
			x: event.clientX,
			y: event.clientY,
			items: [{ label: 'Disconnect', action: () => deleteEdge(id) }]
		};
	};

</script>

<div class="flex h-full w-full">
	{#if paletteOpen}
		<div
			class="flex h-full w-40 shrink-0 flex-col overflow-hidden"
			style="order: {paletteSide === 'right' ? 3 : 1}"
			bind:clientHeight={paletteColH}
		>
			<!-- #20 P7: the graph navigator sits ABOVE the palette in the same pane -->
			<GraphTree
				kind="flow"
				documents={$flowGraphs}
				sceneKey={SCENE_GRAPH}
				label="Flows"
				paneHeight={paletteColH}
			/>
			<div class="min-h-0 flex-1 overflow-y-auto">
				<Sidebar onPick={addNodeAtCenter} onPlaceAt={addNodeAtScreen} />
			</div>
		</div>
	{/if}
	<!-- palette collapse/side controls: notebook-tab buttons on the divider (82) -->
	<div class="relative z-10 w-0" style="order: 2">
		<button
			id="palette-toggle"
			class="palette-tab {paletteSide === 'right' ? 'palette-tab-mirrored' : ''} absolute top-8 flex h-14 w-4 items-center justify-center bg-gray-700 text-[10px] text-gray-200 hover:bg-gray-600"
			style="{paletteSide === 'right' ? 'right' : 'left'}: -1px"
			title={paletteOpen ? 'Hide the node palette' : 'Show the node palette'}
			onclick={() => {
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
			onclick={() => {
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
		onpointermove={onPointerMoveCursor}
		onpointerleave={onPointerLeaveCursor}
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
					class="pointer-events-auto rounded-full border border-gray-700/60 bg-gray-800/85 px-2 py-0.5 text-xs text-gray-400 backdrop-blur-sm hover:text-gray-100"
					title="Back to the Scene flow (deselects the object)"
					onclick={() => deselectObject()}
				>
					⌂ Scene
				</button>
			{/if}
			<span
				class="pointer-events-auto rounded-full border border-gray-700/60 bg-gray-800/85 px-2.5 py-0.5 text-xs text-gray-200 backdrop-blur-sm"
			>
				{activeId === SCENE_GRAPH ? 'Scene flow' : activeOwnerName + ' — object flow'}
			</span>
			{#if activeId !== SCENE_GRAPH && hasActiveGraph}
				<button
					id="flow-scope-delete"
					class="pointer-events-auto rounded-full border border-gray-700/60 bg-gray-800/85 px-2 py-0.5 text-xs text-gray-400 backdrop-blur-sm hover:text-red-400"
					title="Delete this object's flow"
					onclick={() => requestDeleteObjectGraph(activeId, activeOwnerName)}
				>
					<Trash2 size={16} aria-hidden="true" />
				</button>
			{/if}
			<!-- A6.4: how many nodes in THIS graph cannot be rendered. Counted per
			     graph, because that is the graph the user is looking at; the
			     Notification Center entry on scene load covers the case where the
			     editor is closed entirely. -->
			{#if unknownHere}
				<button
					id="flow-unknown-badge"
					class="pointer-events-auto rounded-full border border-yellow-600/60 bg-yellow-900/40 px-2.5 py-0.5 text-xs font-semibold text-yellow-300 backdrop-blur-sm hover:bg-yellow-900/70"
					title="These nodes come from a module that isn't installed — click to open Modules"
					onclick={() => modulesOpen.set(true)}
				>
					⚠ {unknownHere} node{unknownHere === 1 ? ' needs' : 's need'} modules
				</button>
			{/if}
		</div>

		<!-- H1: empty state — the selected object has no flow document yet -->
		{#if activeId !== SCENE_GRAPH && !hasActiveGraph}
			<div
				id="flow-empty-state"
				class="absolute inset-0 z-5 flex flex-col items-center justify-center gap-3 bg-gray-900/60 backdrop-blur-[2px]"
			>
				<p class="text-sm text-gray-300">
					<span class="font-semibold text-gray-100">{activeOwnerName}</span> has no flow yet
				</p>
				<button
					id="flow-create-btn"
					class="rounded-lg bg-primary-700 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600"
					onclick={() => createObjectGraph(activeId)}
				>
					Create flow
				</button>
				<p class="text-[11px] text-gray-500">Nodes here will drive this object (no Object Selector needed)</p>
			</div>
		{/if}
		<SvelteFlow
			bind:nodes
			{nodeTypes}
			bind:edges
			{snapGrid}
			bind:viewport
			{onbeforeconnect}
			{ondelete}
			{isValidConnection}
			defaultEdgeOptions={{ type: edgeStyle, markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 } }}
			deleteKey={['Backspace', 'Delete']}
			fitView
			maxZoom={1}
			minZoom={0.5}
			ondragover={onDragOver}
			ondrop={onDrop}
			onnodedragstop={onNodeDragStop}
			onpanecontextmenu={onPaneContextMenu}
			onnodecontextmenu={onNodeContextMenu}
			onedgecontextmenu={onEdgeContextMenu}
			onpaneclick={() => (menu = null)}
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
			onclick={() => { propsOpen = !propsOpen; LS?.setItem('flowPropsOpen', String(propsOpen)); }}
		>
			⚙
		</button>
	</div>
	{#if propsOpen}
		<div id="flow-props" class="flex h-full w-52 shrink-0 flex-col gap-2 overflow-y-auto bg-gray-800 p-2 text-xs text-gray-200" style="order: {propsSide === 'left' ? -1 : 5}">
			<!-- 4.3: Explorer-style tabs — ⓘ = the selected node's PARAMETERS,
			     ⚙ = graph settings + node name/note (as before) -->
			<div class="flex gap-1">
				<button id="flow-tab-info" class="flex-1 rounded-sm px-2 py-1 {propsTab === 'info' ? 'bg-primary-700 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					onclick={() => { propsTab = 'info'; LS?.setItem('flowPropsTab', 'info'); }}>ⓘ Params</button>
				<button id="flow-tab-settings" class="flex-1 rounded-sm px-2 py-1 {propsTab === 'settings' ? 'bg-primary-700 text-white' : 'bg-gray-700 hover:bg-gray-600'}"
					onclick={() => { propsTab = 'settings'; LS?.setItem('flowPropsTab', 'settings'); }}>⚙ Settings</button>
			</div>
			{#if propsTab === 'info'}
				{#if selectedNode}
					<p class="ui-section-label">{selectedNode.data?.label ?? selectedNode.type}</p>
					{#if selectedNode.type === 'slider'}
						<label class="flex items-center justify-between gap-2">Min
							<input id="param-slider-min" class="ui-input w-16" type="number" value={selectedNode.data?.min ?? 0}
								onchange={(e) => setNodeData(selectedNode.id, { min: +e.currentTarget.value || 0 })} /></label>
						<label class="flex items-center justify-between gap-2">Max
							<input id="param-slider-max" class="ui-input w-16" type="number" value={selectedNode.data?.max ?? 40}
								onchange={(e) => setNodeData(selectedNode.id, { max: +e.currentTarget.value || 0 })} /></label>
					{:else if selectedNode.type === 'switcher'}
						{#each selectedNode.data?.items ?? ['cube', 'pyramid'] as item, i}
							<div class="flex items-center gap-1">
								<input class="ui-input flex-1" value={item}
									onchange={(e) => {
										const items = [...(selectedNode.data?.items ?? ['cube', 'pyramid'])];
										items[i] = e.currentTarget.value;
										setNodeData(selectedNode.id, { items });
									}} />
								<button class="rounded-sm bg-gray-600 px-1.5 hover:bg-red-700" title="Remove item"
									onclick={() => {
										const items = (selectedNode.data?.items ?? ['cube', 'pyramid']).filter((_: any, x: number) => x !== i);
										if (items.length) setNodeData(selectedNode.id, { items, index: 0, shape: items[0] });
									}}>✕</button>
							</div>
						{/each}
						<button id="param-switcher-add" class="rounded-sm bg-gray-600 px-2 py-1 hover:bg-gray-500"
							onclick={() => {
								const items = [...(selectedNode.data?.items ?? ['cube', 'pyramid']), 'item ' + ((selectedNode.data?.items?.length ?? 2) + 1)];
								setNodeData(selectedNode.id, { items });
							}}>＋ Add item</button>
					{:else if selectedNode.type === 'number'}
						<label class="flex items-center justify-between gap-2">Step
							<input id="param-number-step" class="ui-input w-16" type="number" min="0" value={selectedNode.data?.step ?? 1}
								onchange={(e) => setNodeData(selectedNode.id, { step: +e.currentTarget.value || 1 })} /></label>
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
						onchange={(e) => setNodeData(selectedNode.id, { label: e.currentTarget.value })} /></label>
				<label class="flex flex-col gap-1">Note
					<textarea class="ui-input" rows="2" value={selectedNode.data?.note ?? ''}
						onchange={(e) => setNodeData(selectedNode.id, { note: e.currentTarget.value })}></textarea></label>
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
						onchange={(e) => { showMinimap = e.currentTarget.checked; LS?.setItem('flowMinimap', String(showMinimap)); }} /> Minimap</label>
				<label class="flex items-center gap-2">
					<input type="checkbox" checked={gridSnapOn}
						onchange={(e) => { gridSnapOn = e.currentTarget.checked; LS?.setItem('flowGridSnap', String(gridSnapOn)); }} /> Snap to grid</label>
				<label class="flex items-center gap-2">Grid size
					<input class="ui-input w-16" type="number" min="1" value={gridSize}
						onchange={(e) => { gridSize = +e.currentTarget.value || 25; LS?.setItem('flowGridSize', String(gridSize)); }} /></label>
				<div class="mt-1 flex gap-1">
					<button id="flow-fit" class="rounded-sm bg-gray-600 px-2 py-1 hover:bg-gray-500" onclick={() => fitView()}>Fit</button>
					<button id="flow-reset-view" class="rounded-sm bg-gray-600 px-2 py-1 hover:bg-gray-500" onclick={() => setViewport({ x: 0, y: 0, zoom: 1 })}>Reset view</button>
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
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} sizeKey="nodes" on:close={() => (menu = null)} />
{/if}

<style>
	:global(.svelte-flow) {
		background-color: transparent !important;
	}
	:global(.svelte-flow__attribution) {
		display: none;
	}
</style>
