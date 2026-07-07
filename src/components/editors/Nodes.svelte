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
	import Sidebar from './Sidebar.svelte';
	import ContextMenu from './ContextMenu.svelte';
	import ColorPickerNode from './nodes/ColorPickerNode.svelte';
	import SliderNode from './nodes/SliderNode.svelte';
	import SwitcherNode from './nodes/SwitcherNode.svelte';
	import ObjectSelectorNode from './nodes/ObjectSelectorNode.svelte';
	import AnimationNode from './nodes/AnimationNode.svelte';
	import { flowNodes as nodes, flowEdges as edges } from '../../stores/flowStore';
	import { serializeNode, serializeEdge, deleteFlowNodes, deleteFlowEdges } from '$lib/nodesHandler';
	import { findNodeSpec } from '$lib/nodeCatalog';
	import { peers } from '../../stores/appStore';

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
		blink: AnimationNode
	};

	const snapGrid: [number, number] = [25, 25];
	const { screenToFlowPosition } = useSvelteFlow();

	// Stores are initialized with null, so their inferred type is unusable here
	let peer: any;
	$: peer = $peers;

	// active context menu: { kind: 'pane'|'node'|'edge', x, y, flowPos?, targetId? }
	let menu: any = null;

	function addNode(type: string, label: string, position: { x: number; y: number }) {
		const spec = findNodeSpec(type);
		const newNode = {
			id: crypto.randomUUID(),
			type,
			position,
			data: {
				label: label,
				type: type,
				...(spec?.defaults ?? {})
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

	const onPaneContextMenu = (event: CustomEvent<{ event: MouseEvent }>) => {
		const e = event.detail.event;
		e.preventDefault();
		menu = {
			kind: 'pane',
			x: e.clientX,
			y: e.clientY,
			flowPos: screenToFlowPosition({ x: e.clientX, y: e.clientY })
		};
	};

	const onNodeContextMenu = (event: CustomEvent<{ event: MouseEvent; node: Node }>) => {
		event.detail.event.preventDefault();
		menu = {
			kind: 'node',
			x: event.detail.event.clientX,
			y: event.detail.event.clientY,
			targetId: event.detail.node.id
		};
	};

	const onEdgeContextMenu = (event: CustomEvent<{ event: MouseEvent; edge: Edge }>) => {
		event.detail.event.preventDefault();
		menu = {
			kind: 'edge',
			x: event.detail.event.clientX,
			y: event.detail.event.clientY,
			targetId: event.detail.edge.id
		};
	};

	function menuAddNode(item: any) {
		addNode(item.type, item.label, menu.flowPos);
		menu = null;
	}

	function menuDeleteNode() {
		const ids = [menu.targetId];
		deleteFlowNodes(ids);
		peer?.send({ type: 'nodedelete', ids: ids });
		menu = null;
	}

	function menuDisconnectNode() {
		const id = menu.targetId;
		const ids = $edges.filter((e) => e.source === id || e.target === id).map((e) => e.id);
		if (ids.length) {
			deleteFlowEdges(ids);
			peer?.send({ type: 'edgedelete', ids: ids });
		}
		menu = null;
	}

	function menuDeleteEdge() {
		const ids = [menu.targetId];
		deleteFlowEdges(ids);
		peer?.send({ type: 'edgedelete', ids: ids });
		menu = null;
	}
</script>

<div class="flex h-full w-full">
	<div class="h-full w-40 shrink-0 overflow-y-auto">
		<Sidebar />
	</div>
	<div class="svelteFlow h-full grow">
		<SvelteFlow
			{nodes}
			{nodeTypes}
			{edges}
			{snapGrid}
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
	</div>
</div>

{#if menu}
	<ContextMenu
		{menu}
		on:close={() => (menu = null)}
		on:addnode={(e) => menuAddNode(e.detail)}
		on:deletenode={menuDeleteNode}
		on:disconnectnode={menuDisconnectNode}
		on:deleteedge={menuDeleteEdge}
	/>
{/if}

<style>
	:global(.svelte-flow) {
		background-color: transparent !important;
	}
	:global(.svelte-flow__attribution) {
		display: none;
	}
</style>
