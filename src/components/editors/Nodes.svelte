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
	import { writable } from 'svelte/store';
	import Sidebar from './Sidebar.svelte';
	import PeerCursors from './PeerCursors.svelte';
	import ContextMenu from '../ContextMenu.svelte';
	import ColorPickerNode from './nodes/ColorPickerNode.svelte';
	import SliderNode from './nodes/SliderNode.svelte';
	import SwitcherNode from './nodes/SwitcherNode.svelte';
	import ObjectSelectorNode from './nodes/ObjectSelectorNode.svelte';
	import AnimationNode from './nodes/AnimationNode.svelte';
	import { flowNodes as nodes, flowEdges as edges } from '../../stores/flowStore';
	import { serializeNode, serializeEdge, deleteFlowNodes, deleteFlowEdges } from '$lib/nodesHandler';
	import { findNodeSpec, nodeCatalog } from '$lib/nodeCatalog';
	import { peers, username } from '../../stores/appStore';

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
			items: nodeCatalog.map((group) => ({
				label: group.group,
				children: group.items.map((item) => ({
					label: item.label,
					action: () => addNode(item.type, item.label, flowPos)
				}))
			}))
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
