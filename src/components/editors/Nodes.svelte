<script lang="ts">
	import {
		SvelteFlow,
		Background,
		BackgroundVariant,
		useSvelteFlow,
		type Node,
		type Edge,
		type Connection
	} from '@xyflow/svelte';
	// 👇 this is important! You need to import the styles for Svelte Flow to work
	import '@xyflow/svelte/dist/style.css';
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
	import CustomNode from './nodes/CustomNode.svelte';
	import PathPatrolNode from './nodes/PathPatrolNode.svelte';
	import { flowNodes as nodes, flowEdges as edges, customNodeDefs, nodeDesignerOpen } from '../../stores/flowStore';
	import { serializeNode, serializeEdge, deleteFlowNodes, deleteFlowEdges } from '$lib/nodesHandler';
	import { defDefaults } from '$lib/customNodes';
	import { findNodeSpec, nodeCatalog } from '$lib/nodeCatalog';
	import { moduleNodeGroups, moduleNodeComponents } from '$lib/moduleSDK';
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
		customnode: CustomNode,
		pathpatrol: PathPatrolNode,
		...moduleTypes
	};

	const snapGrid: [number, number] = [25, 25];
	const { screenToFlowPosition } = useSvelteFlow();

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
			y: position.y
		});
	};
	const onPointerLeaveCursor = () => {
		if (peer) peer.send({ type: 'flowcursor', id: peer.peer.id, leave: true });
	};

	// active context menu: { x, y, items }
	let menu: any = null;

	function addNode(type: string, label: string, position: { x: number; y: number }, extraDefaults: any = null) {
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
		peer?.send({ type: 'nodecreate', node: serializeNode(newNode) });
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
			peer?.send({ type: 'nodemove', id: node.id, position: { x: node.position.x, y: node.position.y } });
		});
	};

	// Give new edges a deterministic id and replicate them to all peers
	const onedgecreate = (connection: Connection) => {
		const edge = {
			id: `e-${connection.source}-${connection.target}`,
			source: connection.source,
			target: connection.target,
			sourceHandle: connection.sourceHandle,
			targetHandle: connection.targetHandle
		} satisfies Edge;
		peer?.send({ type: 'edgecreate', edge: serializeEdge(edge) });
		return edge;
	};

	// Replicate deletions (Backspace / Delete key)
	const ondelete = ({ nodes: deletedNodes, edges: deletedEdges }: { nodes: Node[]; edges: Edge[] }) => {
		if (deletedNodes.length)
			peer?.send({ type: 'nodedelete', ids: deletedNodes.map((n) => n.id) });
		if (deletedEdges.length)
			peer?.send({ type: 'edgedelete', ids: deletedEdges.map((e) => e.id) });
	};

	// --- context menus ---

	function deleteNode(id: string) {
		deleteFlowNodes([id]);
		peer?.send({ type: 'nodedelete', ids: [id] });
	}

	function disconnectNode(id: string) {
		const ids = $edges.filter((e) => e.source === id || e.target === id).map((e) => e.id);
		if (ids.length) {
			deleteFlowEdges(ids);
			peer?.send({ type: 'edgedelete', ids: ids });
		}
	}

	function deleteEdge(id: string) {
		deleteFlowEdges([id]);
		peer?.send({ type: 'edgedelete', ids: [id] });
	}

	const onPaneContextMenu = (event: CustomEvent<{ event: MouseEvent }>) => {
		const e = event.detail.event;
		e.preventDefault();
		const flowPos = screenToFlowPosition({ x: e.clientX, y: e.clientY });
		menu = {
			x: e.clientX,
			y: e.clientY,
			items: [
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

	const onNodeContextMenu = (event: CustomEvent<{ event: MouseEvent; node: Node }>) => {
		event.detail.event.preventDefault();
		const id = event.detail.node.id;
		menu = {
			x: event.detail.event.clientX,
			y: event.detail.event.clientY,
			items: [
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
</script>

<div class="flex h-full w-full">
	<div class="h-full w-40 shrink-0 overflow-y-auto">
		<Sidebar />
	</div>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div
		class="svelteFlow relative h-full grow"
		on:pointermove={onPointerMoveCursor}
		on:pointerleave={onPointerLeaveCursor}
	>
		<SvelteFlow
			{nodes}
			{nodeTypes}
			{edges}
			{snapGrid}
			{viewport}
			{onedgecreate}
			{ondelete}
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
			<Background bgColor="transparent" variant={BackgroundVariant.Dots} />
		</SvelteFlow>
		<PeerCursors {viewport} />
	</div>
</div>

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menu.items} on:close={() => (menu = null)} />
{/if}

<style>
	:global(.svelte-flow) {
		background-color: transparent !important;
	}
	:global(.svelte-flow__attribution) {
		display: none;
	}
</style>
