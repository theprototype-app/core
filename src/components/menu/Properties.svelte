<script>
import * as THREE from 'three';
import {
	Tooltip,
	Accordion,
	AccordionItem,
	Checkbox,
	Select,
	Drawer,
	CloseButton,
	NumberInput,
	Input,
	Range,
	Button
} from 'flowbite-svelte';
import { setObjectTexture, removeObjectTexture, setMaterialParam, switchMaterialType } from '$lib/materialsHandler';
import { moveObjectToGroup } from '$lib/objectActions';
import { objectsGroup, TControls, selectedObject } from '../../stores/sceneStore';
import { peers, chatHidden, propertiesClose, toggleExpand } from '../../stores/appStore.js';
import ColorPicker,{ ChromeVariant }  from 'svelte-awesome-color-picker';
import CustomWrapper from '$lib/ColorWrapper.svelte';
import { sineIn } from 'svelte/easing';

import { sendObject } from '$lib/commandsHandler.svelte';

let color = $state();
let selectedMaterial = $state(null);

let moving;
let { min_position_x, max_position_x, min_position_y, max_position_y, min_position_z, max_position_z,
      min_rotation_x, max_rotation_x, min_rotation_y, max_rotation_y, min_rotation_z, max_rotation_z,
      min_scale_x, max_scale_x, min_scale_y, max_scale_y, min_scale_z, max_scale_z
 } = $state(0) //reactivity for slider min/max values

let transitionParamsRight = {
    x: 320,
    duration: 200,
    easing: sineIn
};

let st = $state(0)
let rerenderSelectGroup = $state(0)

let materials = [
    { value: 'MeshBasicMaterial', name: 'Basic' },
    { value: 'MeshStandardMaterial', name: 'Standard' },
    // { value: 'MeshNormalMaterial', name: 'Normals' },
    { value: 'MeshPhongMaterial', name: 'Phong' },
    { value: 'MeshToonMaterial', name: 'Toon' },
    { value: 'ShadowMaterial', name: 'Shadow' }
  ];

  let groups = $state([{
    value: 'none',
    name: 'None'
  }]);

function event(node) {
      //Center slide
     //-3 = -1 +5 //-2 = 0 +4 //-1 = -1 +3
    //0 = -2 +2 //1 = -3 +1 //2 = -4  0
    min_position_x = $selectedObject.position.x-($selectedObject.position.x+2)
    max_position_x = $selectedObject.position.x+(($selectedObject.position.x-2)*-1)
    min_position_y = $selectedObject.position.y-($selectedObject.position.y+2)
    max_position_y = $selectedObject.position.y+(($selectedObject.position.y-2)*-1)
    min_position_z = $selectedObject.position.z-($selectedObject.position.z+2)
    max_position_z = $selectedObject.position.z+(($selectedObject.position.z-2)*-1)

    min_rotation_x = $selectedObject.rotation.x-($selectedObject.rotation.x+2)
    max_rotation_x = $selectedObject.rotation.x+(($selectedObject.rotation.x-2)*-1)
    min_rotation_y = $selectedObject.rotation.y-($selectedObject.rotation.y+2)
    max_rotation_y = $selectedObject.rotation.y+(($selectedObject.rotation.y-2)*-1)
    min_rotation_z = $selectedObject.rotation.z-($selectedObject.rotation.z+2)
    max_rotation_z = $selectedObject.rotation.z+(($selectedObject.rotation.z-2)*-1)

    min_scale_x = $selectedObject.scale.x-($selectedObject.scale.x+2)
    max_scale_x = $selectedObject.scale.x+(($selectedObject.scale.x-2)*-1)
    min_scale_y = $selectedObject.scale.y-($selectedObject.scale.y+2)
    max_scale_y = $selectedObject.scale.y+(($selectedObject.scale.y-2)*-1)
    min_scale_z = $selectedObject.scale.z-($selectedObject.scale.z+2)
    max_scale_z = $selectedObject.scale.z+(($selectedObject.scale.z-2)*-1)
    
    node.addEventListener('mousedown', () => {
        moving = true;
    });

    window.addEventListener('mousemove', (e) => {
        if (typeof $selectedObject !== 'undefined')
        if (!$selectedObject.type != 'Group')    
        if (!$selectedObject.type.endsWith('Light'))
        if (typeof $selectedObject.material !== "undefined")
        if ($selectedObject.material.type !== "MeshNormalMaterial")
        color = $selectedObject.material.color.getHexString()

        if (typeof $selectedObject !== 'undefined')
        if (moving) {
            $peers.send({
						type: 'move',
						uuid: $selectedObject.uuid,
						pos: $selectedObject.position.toArray(),
						rot: $selectedObject.rotation.toArray(),
						scale: $selectedObject.scale.toArray()
					});
        }
        
    });

    window.addEventListener('mouseup', () => {
        moving = false;
        if (typeof $selectedObject !== 'undefined')
        {
        min_position_x = $selectedObject.position.x-5
        max_position_x = $selectedObject.position.x+5
        min_position_y = $selectedObject.position.y-5
        max_position_y = $selectedObject.position.y+5
        min_position_z = $selectedObject.position.z-5
        max_position_z = $selectedObject.position.z+5

        min_rotation_x = $selectedObject.rotation.x-1
        max_rotation_x = $selectedObject.rotation.x+1
        min_rotation_y = $selectedObject.rotation.y-1
        max_rotation_y = $selectedObject.rotation.y+1
        min_rotation_z = $selectedObject.rotation.z-1
        max_rotation_z = $selectedObject.rotation.z+1

        min_scale_x = $selectedObject.scale.x-5
        max_scale_x = $selectedObject.scale.x+5
        min_scale_y = $selectedObject.scale.y-5
        max_scale_y = $selectedObject.scale.y+5
        min_scale_z = $selectedObject.scale.z-5
        max_scale_z = $selectedObject.scale.z+5
        }
    });
}

// Drawer show full screen
let drawerStyle = $state();

$effect(() => {
    if ($chatHidden === '') {
        drawerStyle="bottom: 350px; z-index: 48; border-bottom-left-radius: 0.5rem;"
    } else {
        drawerStyle="bottom: 0px; z-index: 48"
    }
})

function sendUpdate(caseType) {
    if (caseType === "visible")
        $peers.send({ type: 'objectParameters', parameter: 'visible', uuid: $selectedObject.uuid, visible: $selectedObject.visible });
    else if (caseType === "castShadow")
        $peers.send({ type: 'objectParameters', parameter: 'castShadow', uuid: $selectedObject.uuid, castShadow: $selectedObject.castShadow });
    else if (caseType === "receiveShadow")
        $peers.send({ type: 'objectParameters', parameter: 'receiveShadow', uuid: $selectedObject.uuid, receiveShadow: $selectedObject.receiveShadow });
    else if (caseType === "material")
        $peers.send({ type: 'objectParameters', parameter: 'material', uuid: $selectedObject.uuid, material: $selectedObject.material.type });
    else {
        // Backup case by resending entire hierarchy of objects
        $peers.send({type: 'delete', uuid: $selectedObject.uuid, peerId: $peers.peer.id});
        sendObject($peers, $selectedObject.parent, $selectedObject.uuid);
    }
    // conn = peer.connections[peerId];
    //     $peers.send({
    //         type: 'object',
    //         element: $selectedObject.toJSON(),
    //         override: true
    //     });
    }

function sendTransformUpdate() {
    if (typeof $TControls.object !== 'undefined')
			if (typeof $TControls.object.parent !== 'undefined')
				if (typeof $TControls.object.uuid !== 'undefined') {
					$TControls.visible = true;
					$peers.send({
						type: 'move',
						uuid: $TControls.object.uuid,
						pos: $TControls.object.position.toArray(),
						rot: $TControls.object.rotation.toArray(),
						scale: $TControls.object.scale.toArray()
					});
				}
}
</script>
  
  <Drawer
	style={drawerStyle}
	activateClickOutside={false}
	backdrop={false}
	placement="right"
	height="full"
	position="fixed"
	rightOffset="end-0 top-16"
	leftOffset="start-0 "
	topOffset="top-16"
	transitionType="fly"
	transitionParams={transitionParamsRight}
	bind:hidden={$propertiesClose}
	class="rounded-tl-lg"
	id="sidebar6"
  >
    <div class="flex items-center">
      <h5 id="drawer-label" class="inline-flex items-center mb-4 text-base font-semibold text-gray-500 dark:text-gray-400">
        {$selectedObject.type} Properties
      </h5>
      <CloseButton on:click={() => {(propertiesClose.set(true)); st=0}} class="mb-4 dark:text-white" />
    </div>
    {#if $selectedObject.name !== undefined}
    {st=null}

    
    <Input id="name" class="text-white dark:text-slate-200 -rounded rounded-tl-lg rounded-tr-lg" bind:value={$selectedObject.name}
        onchange={() => {
        //Trigger reactivity for UI list of objects
        objectsGroup.update((value) => value);
        $peers.send({
            type: 'name',
            name: $selectedObject.name,
            uuid: $selectedObject.uuid
        });
        }} />
        <Tooltip placement='top' arrow={false} triggeredBy="#name">Name</Tooltip>
    
    <Input id="uuid" class="text-white dark:text-slate-200 -rounded rounded-bl-lg rounded-br-lg" disabled value={$selectedObject.uuid} />
    <Tooltip placement='bottom' arrow={false} triggeredBy="#uuid">UUID</Tooltip>
    
    <p
    on:click={() => { 
        groups = $selectedObject.parent.children
					.map((item) => (item.type === 'Group' ? { name: item.name, value: item.uuid } : null))
					.filter(Boolean);
        if($selectedObject.parent.parent.parent !== null)
        groups.push({ name: 'Level Up', value: $selectedObject.parent.parent.uuid })
        groups = groups.filter(item => item.value !== $selectedObject.uuid)
     }}>
    {#key rerenderSelectGroup}
    <Select id="select-group" underline class="mt-2" items={groups} placeholder="Move to group"
    on:change={(event) => {
        let selected = groups.find(item => item.value === event.srcElement.value)
        moveObjectToGroup($selectedObject.uuid, selected.name === "Level Up" ? 'up' : event.srcElement.value);
        $objectsGroup = $objectsGroup;

        // Trigger to refresh the select group as it have only on change
		// and we want to run event even if the same value is selected
        rerenderSelectGroup = rerenderSelectGroup ? false : true
    }}
    />
    {/key}
    </p>
    <Tooltip placement='bottom' arrow={false} triggeredBy="#uuid">Move to group</Tooltip>

    <div use:event>
    <Accordion class="text-white dark:text-slate-200 w-full" flush>
  {#if $selectedObject.type !== "Group"}
  <AccordionItem>
    <svelte:fragment slot="header">Color</svelte:fragment>
    
    
    <ColorPicker
    label="test"
    isAlpha={false}
    isTextInput={false}
    isDialog={false}
    components={{...ChromeVariant, wrapper: CustomWrapper}} 
    isOpen={true}
    sliderDirection="horizontal"
    --picker-indicator-size="20px"
    --cp-bg-color="#1f2937"
    --cp-border-color="#353f4e"
    --picker-height="70px"
    --picker-width="50px"
    --slider-width="10px"    
    bind:value={color}
    on:input={(event) => {
        if ($selectedObject.material.type !== "MeshNormalMaterial"){
        $selectedObject.material.color.set(event.detail.hex);
        $peers.send({
						type: 'color',
						uuid: $selectedObject.uuid,
                        color: event.detail.hex
					});
        }
    }}
    />
    <Input type="text" bind:value={color} onchange={ () => { $selectedObject.material.color.set('#'+color); }} />
    </AccordionItem>
    {/if}
    <AccordionItem>
    <svelte:fragment slot="header">Transform</svelte:fragment>
    <br /><p class="text-white dark:text-slate-200">Position:</p>
    
    
    <div class="flex items-center space-x-2 p-1">
        <span  class="w-2/3 text-right pr-2 truncate">
            <Range id="posx" step="0.1" min={min_position_x} max={max_position_x} bind:value={$selectedObject.position.x}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.position.x} 
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>

    <div class="flex items-center space-x-2 p-1">
        <span  class="w-2/3 text-right pr-2 truncate">
            <Range id="posy" step="0.1" min={min_position_y} max={max_position_y} bind:value={$selectedObject.position.y}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.position.y}
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>

    <div class="flex items-center space-x-2 p-1">
        <span class="w-2/3 text-right pr-2 truncate">
            <Range id="posz" step="0.1" min={min_position_z} max={max_position_z} bind:value={$selectedObject.position.z}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.position.z}
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>

    
    <br /><p class="text-white dark:text-slate-200">Rotation:</p>
    
    <div class="flex items-center space-x-2 p-1">
        <span  class="w-2/3 text-right pr-2 truncate">
            <Range id="posx" step="0.01" min={min_rotation_x} max={max_rotation_x} bind:value={$selectedObject.rotation.x}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.rotation.x}
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>

    <div class="flex items-center space-x-2 p-1">
        <span  class="w-2/3 text-right pr-2 truncate">
            <Range id="posy" step="0.01" min={min_rotation_y} max={max_rotation_y} bind:value={$selectedObject.rotation.y}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.rotation.y}
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>

    <div class="flex items-center space-x-2 p-1">
        <span class="w-2/3 text-right pr-2 truncate">
            <Range id="posz" step="0.01" min={min_rotation_z} max={max_rotation_z} bind:value={$selectedObject.rotation.z}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.rotation.z}
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>

    
    <br /><p class="text-white dark:text-slate-200">Scale:</p>
    
    <div class="flex items-center space-x-2 p-1">
        <span  class="w-2/3 text-right pr-2 truncate">
            <Range id="posx" step="0.1" min={min_scale_x} max={max_scale_x} bind:value={$selectedObject.scale.x}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.scale.x}
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>

    <div class="flex items-center space-x-2 p-1">
        <span  class="w-2/3 text-right pr-2 truncate">
            <Range id="posy" step="0.1" min={min_scale_y} max={max_scale_y} bind:value={$selectedObject.scale.y}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.scale.y}
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>

    <div class="flex items-center space-x-2 p-1">
        <span class="w-2/3 text-right pr-2 truncate">
            <Range id="posz" step="0.1" min={min_scale_z} max={max_scale_z} bind:value={$selectedObject.scale.z}
            onchange={() => { sendTransformUpdate(); }}
            />
        </span>
        <span class="w-1/3">
        <NumberInput bind:value={$selectedObject.scale.z}
        onchange={() => { sendTransformUpdate(); }}
        />
        </span>
    </div>
    </AccordionItem>
    {#if $selectedObject.type !== "Group"}
    <AccordionItem open>
        <svelte:fragment slot="header">Material</svelte:fragment>
        <p class="mb-4 font-semibold text-gray-900 dark:text-white">
            <Checkbox bind:checked={$selectedObject.visible}
            onchange={() => { sendUpdate('visible'); }}>Visible</Checkbox>
        </p>
        {#if typeof $selectedObject?.material?.type !== "undefined"}
        <p class="mb-4 font-semibold text-gray-900 dark:text-white" style="margin-bottom: -40px;">{$selectedObject.material.type}</p>
        <Select id="select-underline" underline class="mt-2" items={materials} bind:value={selectedMaterial}
            on:change={(event) => {
                // switches type but keeps color/texture/opacity, locally and on peers
                switchMaterialType($selectedObject.uuid, event.srcElement.value);
                $selectedObject = $selectedObject; // trigger reactivity
                selectedMaterial = null;
            }}
        />
        {/if}

        <!-- materials supporting textures initialize map to null; ShadowMaterial has no map at all -->
        {#if $selectedObject.material && !Array.isArray($selectedObject.material) && typeof $selectedObject.material.map !== "undefined"}
        <p class="mb-2 mt-4 font-semibold text-gray-900 dark:text-white">Texture</p>
        <input type="file" id="texture-file" accept="image/png, image/jpeg, image/webp" style="display: none"
            on:change={(e) => {
                const file = e.target.files?.[0];
                if (file) setObjectTexture($selectedObject.uuid, file).then(() => { $selectedObject = $selectedObject; });
                e.target.value = '';
            }} />
        <div class="flex items-center gap-3">
            {#if $selectedObject.material.userData?.mapDataUrl}
                <img src={$selectedObject.material.userData.mapDataUrl} alt="texture"
                    class="h-10 w-10 cursor-pointer rounded border border-gray-500 object-cover"
                    on:click={() => document.getElementById('texture-file').click()} />
                <Button size="xs" color="alternative"
                    onclick={() => { removeObjectTexture($selectedObject.uuid); $selectedObject = $selectedObject; }}>Remove</Button>
            {:else}
                <Button size="xs" color="alternative"
                    onclick={() => document.getElementById('texture-file').click()}>Set texture...</Button>
            {/if}
        </div>
        {/if}

        {#if $selectedObject.material?.type === "MeshStandardMaterial"}
        <p class="mb-2 mt-4 font-semibold text-gray-900 dark:text-white">Roughness</p>
        <Range id="mat-roughness" step="0.05" min={0} max={1} value={$selectedObject.material.roughness}
            onchange={(e) => setMaterialParam($selectedObject.uuid, 'roughness', +e.target.value)} />
        <p class="mb-2 mt-4 font-semibold text-gray-900 dark:text-white">Metalness</p>
        <Range id="mat-metalness" step="0.05" min={0} max={1} value={$selectedObject.material.metalness}
            onchange={(e) => setMaterialParam($selectedObject.uuid, 'metalness', +e.target.value)} />
        {/if}
        {#if $selectedObject.material?.type === "MeshPhongMaterial"}
        <p class="mb-2 mt-4 font-semibold text-gray-900 dark:text-white">Shininess</p>
        <Range id="mat-shininess" step="1" min={0} max={100} value={$selectedObject.material.shininess}
            onchange={(e) => setMaterialParam($selectedObject.uuid, 'shininess', +e.target.value)} />
        {/if}
        {#if $selectedObject.material && typeof $selectedObject.material.wireframe !== "undefined"}
        <p class="mb-2 mt-4 font-semibold text-gray-900 dark:text-white">
            <Checkbox checked={$selectedObject.material.wireframe}
                onchange={(e) => setMaterialParam($selectedObject.uuid, 'wireframe', e.target.checked)}>Wireframe</Checkbox>
        </p>
        {/if}

        {#if $selectedObject.material.type === "MeshBasicMaterial"}
        <p class="mb-4 font-semibold text-gray-900 dark:text-white">Color</p>
        <ColorPicker
        label="test"
        isAlpha={false}
        isTextInput={false}
        isDialog={false}
        components={{...ChromeVariant, wrapper: CustomWrapper}} 
        isOpen={true}
        sliderDirection="horizontal"
        --picker-indicator-size="20px"
        --cp-bg-color="#1f2937"
        --cp-border-color="#353f4e"
        --picker-height="70px"
        --picker-width="50px"
        --slider-width="10px"    
        bind:value={color}
        on:input={(event) => {
            $selectedObject.material.color.set(event.detail.hex);
            color = event.detail.hex;
            sendUpdate();
        }}
        />
        <p class="mb-4 font-semibold text-gray-900 dark:text-white">Opacity</p>
        <Range id="posx" step="0.1" min={0} max={1} bind:value={$selectedObject.material.opacity}
        onchange={() => { sendUpdate('opacity'); }}
        />
        {/if}
        <br />
        <p class="mb-4 font-semibold text-gray-900 dark:text-white">Shadow</p>
        <ul class="items-center w-full rounded-lg border border-gray-200 sm:flex dark:bg-gray-800 dark:border-gray-600 divide-x rtl:divide-x-reverse divide-gray-200 dark:divide-gray-600">
            <li class="w-full">
                <Checkbox bind:checked={$selectedObject.castShadow}
                    onchange={() => { sendUpdate('castShadow'); }}
                    class="p-3">Cast
                </Checkbox>
            </li>
            <li class="w-full">
                <Checkbox bind:checked={$selectedObject.receiveShadow}
                    onchange={() => { sendUpdate('receiveShadow'); }} 
                    class="p-3">Receive
                </Checkbox>
            </li>
        </ul>
    </AccordionItem>
    {/if}
    </Accordion>
    </div>
    {:else}
    {st=0}

    {/if}

  </Drawer>