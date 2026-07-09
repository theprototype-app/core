<script lang="ts">
	import { flowGraphClose } from '../stores/appStore.js';
	import { Drawer } from 'flowbite-svelte';
	let transitionParamsRight = {
		z: 320,
		y: 0,
		duration: 200
	};
	import { SvelteFlowProvider } from '@xyflow/svelte';
	import Nodes from './editors/Nodes.svelte';
	import ScriptPanel from './editors/ScriptPanel.svelte';
	import NodeDesigner from './editors/NodeDesigner.svelte';
</script>

<Drawer
	id="flow-list"
	backdrop={false}
	activateClickOutside={false}
	bottomOffset="w-full bottom-0"
	style="z-index: 3; height: 320px"
	placement="bottom"
	transitionType="fly"
	transitionParams={transitionParamsRight}
	hidden={$flowGraphClose}
>
	<div style="height: 290px">
		<SvelteFlowProvider>
			<Nodes />
		</SvelteFlowProvider>
	</div>
</Drawer>

<ScriptPanel />
<NodeDesigner />
