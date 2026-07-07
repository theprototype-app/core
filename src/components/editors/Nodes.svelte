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
	import ColorPickerNode from './nodes/ColorPickerNode.svelte';
	import SliderNode from './nodes/SliderNode.svelte';
	import SwitcherNode from './nodes/SwitcherNode.svelte';
	import ObjectSelectorNode from './nodes/ObjectSelectorNode.svelte';
	import { flowNodes as nodes, flowEdges as edges } from '../../stores/flowStore';
	import { serializeNode, serializeEdge } from '$lib/nodesHandler';
	import { peers } from '../../stores/appStore';
	import { objectsGroup } from '../../stores/sceneStore';

	const nodeTypes = {
		colorpicker: ColorPickerNode,
		slider: SliderNode,
		switcher: SwitcherNode,
		objectselector: ObjectSelectorNode
	};

	const snapGrid: [number, number] = [25, 25];
	const { screenToFlowPosition } = useSvelteFlow();

	// Stores are initialized with null, so their inferred type is unusable here
	let peer: any;
	$: peer = $peers;
	let sceneObjects: any;
	$: sceneObjects = $objectsGroup;

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

		const position = screenToFlowPosition({
			x: event.clientX,
			y: event.clientY
		});

		const newNode = {
			id: crypto.randomUUID(),
			type,
			position,
			data: {
				label: `${type} node`,
				type: type
			},
			class: 'w-[150px]'
		} satisfies Node;

		nodes.update((nodes) => [...nodes, newNode]);
		// Replicate the new node to all peers
		peer?.send({ type: 'nodecreate', node: serializeNode(newNode) });
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

	// Evaluate the graph locally: colorpicker -> objectselector applies the color
	$: evaluateGraph($nodes, $edges);
	function evaluateGraph(nodeList: Node[], edgeList: Edge[]) {
		if (!sceneObjects) return;
		edgeList.forEach((edge) => {
			const source = nodeList.find((node) => node.id === edge.source);
			const target = nodeList.find((node) => node.id === edge.target);
			if (
				source?.type === 'colorpicker' &&
				target?.type === 'objectselector' &&
				source.data.color &&
				target.data.selected &&
				target.data.selected !== '-None-'
			) {
				const object = sceneObjects.getObjectByProperty('uuid', target.data.selected);
				if (object?.material?.color) object.material.color.set(source.data.color);
			}
		});
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
			fitView
			maxZoom={1}
			minZoom={0.5}
			on:dragover={onDragOver}
			on:drop={onDrop}
			on:nodedragstop={onNodeDragStop}
		>
			<Background bgColor="transparent" variant={BackgroundVariant.Dots} />
		</SvelteFlow>
	</div>
</div>

<style>
	:global(.svelte-flow) {
		background-color: transparent !important;
	}
	:global(.svelte-flow__attribution) {
		display: none;
	}
</style>
