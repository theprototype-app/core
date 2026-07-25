<script lang="ts">
    import { peers, loading, loadingcount, pendingApprovals, waitingForApproval, userdata, toastStore, fixLight, showSidebar, specatorMode, restorePanels, appNotice, connectDrawerOpen, connectDrawerTab } from '../../stores/appStore'
    import { restoreAvailable, restoreSnapshot, dismissRestore } from '$lib/autosave'
    import { cancelOutboundRequest } from '$lib/peerApproval'
    import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { objectsGroup, camSave, globalCamera, globalScene } from '../../stores/sceneStore.js';
	import { Progressbar, Toast, Button } from 'flowbite-svelte';
    import { fly } from 'svelte/transition';

let showToast = $state(false);

// CN redesign: while the connect drawer's Toasts tab is open, hide the live toast
// pop-ups (they'd cover the drawer). They still land in the notification history the
// tab shows, so nothing is lost. Critical connection-request toasts are NOT hidden.
const suppressLiveToasts = $derived($connectDrawerOpen && $connectDrawerTab === 'toasts');

// U-3: cap how many generic toasts stack at once (older ones collapse into a
// "+N more" line) so bursts can't fill the screen
const MAX_TOASTS = 4;

$effect(() => {
    if($loading.length > 0) showToast = true;
    if($loading.length > 0)
    if($objectsGroup)
    // Remove loaded UUIDs from the loading array
    // once their corresponding objects are available
    $loading.forEach((uuid) => {
        $objectsGroup.getObjectByProperty('uuid', uuid)
        if ($objectsGroup.getObjectByProperty('uuid', uuid)) {
            $loading.splice($loading.indexOf(uuid, 0), 1);
            $loading = $loading // Trigger reactivity
        }
    })
    
    if (($loadingcount-$loading.length) === $loadingcount) {
        trigger();
    }
});

let toastStatus = $state(true);

let counter = 2;

function trigger() {
toastStatus = true;
counter = 2;
timeout();
}

function timeout() {
if (--counter > 0) return setTimeout(timeout, 4000);
toastStatus = false;
}
</script>
<!-- E1: CRITICAL container — connection requests + pending outbound requests stay
     ABOVE modals (--z-toast) so an approval is never missed while a modal is open. -->
<div class="my-4 toasts-container toasts-critical"
style="left: 50%; max-width: 500px; transform: translate(-50%, 0%); z-index: var(--z-toast); pointer-events: none;"
>
{#each $pendingApprovals as approval}
<div class="my-1">
{#if approval.status != 'retry'}
<Toast  transition={fly} class="p-2 rounded-lg dark:bg-green-800 dark:border-dark-700 border-2 border-green-500" divClass="flex items-center gap-3">
    <div style="position: relative; left: 50%; transform: translate(-25%, -50%);">

    </div>
    <div class="mb-1 text-base font-medium text-green-700 dark:text-green-500 inline-flex items-center">

        <p class="text-sm font-medium text-gray-500 dark:text-gray-200 pr-4 overflow-hidden max-w-80">
            Connection request from peer:&nbsp;{approval.peerId}
        </p>


        <Button
            color="primary"
            class="nob rounded bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
            onclick={() => {
                // Remove approved peer from pending approvals
                $pendingApprovals = $pendingApprovals.filter(peer => peer.peerId !== approval.peerId);

                // Add peer to user data (whitelist)
                let data = [approval.peerId, '', '']
                $userdata.push(data);

                // Broadcast updated whitelist to all connected peers
                $peers.send({type: 'userdata', userdata: $userdata})

                // Simply connect as requester whitelisted us
                $peers.connectToPeer(approval.peerId, true);
            }}
            >Approve</Button
        >

    </div>
</Toast>
{:else}
<Toast  transition={fly} class="p-2 rounded-lg dark:bg-green-800 dark:border-dark-700 border-2 border-green-500" divClass="flex items-center gap-3">
    <div style="position: relative; left: 50%; transform: translate(-25%, -50%);">

    </div>
    <div class="mb-1 text-base font-medium text-green-700 dark:text-green-500 inline-flex items-center">

        <p class="text-sm font-medium text-gray-500 dark:text-gray-200 pr-4 overflow-hidden max-w-80">
            Connection &nbsp;{approval.peerId} already exists
        </p>


        <Button
            color="primary"
            class="nob rounded bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
            onclick={() => {
                console.log($peers.connections[approval.peerId])
                $peers.connections[approval.peerId].close();
                // Remove approved peer from pending approvals
                $pendingApprovals = $pendingApprovals.filter(peer => peer.peerId !== approval.peerId);

                // Broadcast updated whitelist to all connected peers
                $peers.send({type: 'userdata', userdata: $userdata})

                // Simply connect as requester whitelisted us
                $peers.connectToPeer(approval.peerId, true);
            }}
            >Retry</Button
        >

    </div>
</Toast>
{/if}
</div>
{/each}

{#each $waitingForApproval as status}
{#if status[1] === 'pending'}
<div class="my-1">
<Toast  transition={fly} class="p-2 rounded-lg dark:bg-green-800 dark:border-dark-700 border-2 border-green-500" divClass="flex items-center gap-3">
    <div style="position: relative; left: 50%; transform: translate(-25%, -50%);">

    </div>
    <div class="mb-1 text-base font-medium text-green-700 dark:text-green-500 inline-flex items-center">

        <p class="text-sm font-medium text-gray-500 dark:text-gray-400 pr-4 overflow-hidden max-w-80">
            Connection request to peer:&nbsp;{status[0]} <br />
            Status: {status[1]}
        </p>

        <!-- CN: cancel the outbound request (same path as the pill's Cancel) -->
        <Button
            color="yellow"
            class="nob rounded bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-600 dark:text-gray-900 dark:hover:bg-amber-500"
            onclick={() => cancelOutboundRequest(status[0])}
            >Cancel</Button
        >
    </div>

</Toast>
</div>
{/if}
{/each}
</div>

<!-- pointer-events: none lets clicks pass through the (invisible) container area;
     each toast re-enables them for itself. REGULAR container: info/decision toasts
     sit BELOW modals (--z-toast-low) so Settings/Modules/Sessions cover them. -->
<div class="my-4 toasts-container toasts-regular"
class:cxd-hidden={suppressLiveToasts}
style="left: 50%; max-width: 500px; transform: translate(-50%, 0%); z-index: var(--z-toast-low); pointer-events: none;"
>
{#if showToast}
{#if $loadingcount > 0}
<Toast  dismissable={false} transition={fly} bind:toastStatus>
	<div class="mb-1 text-base font-medium text-green-700 dark:text-green-500">Receiving objects: {($loadingcount-$loading.length)}/{$loadingcount}</div>
	<Progressbar progress="{100 * (($loadingcount-$loading.length) - 0) / ($loadingcount - 0)}" color="green" />
</Toast>
{/if}
{/if}


{#if $restoreAvailable}
<div class="my-1">
    <Toast dismissable={false} transition={fly} class="p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700 border-2 border-blue-500" divClass="flex items-center gap-3">
        <div style="position: relative; left: 50%; transform: translate(-25%, -50%);"></div>
        <div class="mb-1 inline-flex items-center text-base font-medium">
            <p class="max-w-80 overflow-hidden pr-4 text-sm font-medium text-gray-500 dark:text-gray-200">
                Restore previous session?<br />
                {$restoreAvailable.objects} objects, saved {new Date($restoreAvailable.ts).toLocaleTimeString()}
            </p>
            <Button
                color="primary"
                class="nob rounded bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
                onclick={() => restoreSnapshot()}>Restore</Button
            >
            <Button
                color="alternative"
                class="nob ml-2 rounded"
                onclick={() => dismissRestore()}>Dismiss</Button
            >
        </div>
    </Toast>
</div>
{/if}

<!-- First-run info banner. Content comes from the `appNotice` store: the OSS build
     shows a "local version" notice; the cloud plugin (VITE_CLOUD_PLUGIN) can clear
     it (appNotice.set(null)) or rebrand it. Dismissed once via hasSeenDisclaimer. -->
{#if $appNotice && typeof localStorage !== 'undefined' && !localStorage.getItem('hasSeenDisclaimer')}
<div class="my-1">
    <Toast  transition={fly} class="p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700 border-2 border-blue-500" divClass="flex items-center gap-3" on:close={() =>
        { localStorage.setItem('hasSeenDisclaimer', 'true'); }
        }>
        <div style="position: relative; left: 50%; transform: translate(-25%, -50%);">

        </div>
        <div class="mb-1 text-base font-medium text-black-700 dark:text-brack-500 inline-flex items-center">

            <p class="text-sm font-medium text-gray-500 dark:text-gray-200 pr-4 overflow-hidden max-w-80">
                {$appNotice.text}<br />
            </p>
            {#if $appNotice.ctaUrl}
            <Button
            color="primary"
            class="nob rounded bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
            onclick={() => {
                window.open($appNotice.ctaUrl, '_blank');
            }}
            >{$appNotice.ctaLabel || 'Learn more'}</Button
        >
            {/if}
        </div>

    </Toast>
    </div>
{/if}

{#if $specatorMode}
<div class="my-1">
    <Toast dismissable={false} transition={fly} class="p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700  border-2 border-red-500" divClass="flex items-center gap-3" on:close={() => 
        { localStorage.setItem('hasSeenDisclaimer', 'true'); }
        }>
        <div style="position: relative; left: 50%; transform: translate(-25%, -50%);">
    
        </div>
        <div class="mb-1 text-base font-medium text-black-700 dark:text-brack-500 inline-flex items-center">
            
            <p class="text-sm font-medium text-gray-500 dark:text-gray-200 pr-4 overflow-hidden max-w-80">
                
                Watching: {$specatorMode}<br />
                
            </p>
            <Button
            color="primary"
            class="nob rounded bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
            onclick={() => {
                let dolly = $globalScene.getObjectByName('dolly')
                dolly.attach($globalCamera)
                $globalScene.getObjectByName($specatorMode).visible = true
                $specatorMode = false;
                $globalCamera.position.copy($camSave.position)
                $globalCamera.rotation.copy($camSave.rotation)
                $globalCamera.fov = $camSave.fov
                $globalCamera.updateProjectionMatrix()


                //specating has ended send camera position once to appear for peers
                $peers.send({ type: 'camera', peerId: $peers.peer.id, position: $globalCamera.position.toArray(), rotation: $globalCamera.rotation.toArray() });
                $peers.send({ type: 'specator', peerId: $peers.peer.id, watching: 'false' });
                // $globalCamera.zoom = $camSave.zoom
                // bring back the panels hidden when spectating started
                restorePanels();
            }}
            >Exit</Button
        >
        </div>
    
    </Toast>
    </div>
{/if}

{#if $fixLight}
<div class="my-1">
    <Toast  transition={fly} class="p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700 border-2 border-red-500" divClass="flex items-center gap-3" on:close={() => 
        { localStorage.setItem('hasSeenDisclaimer', 'true'); }
        }>
        <div style="position: relative; left: 50%; transform: translate(-25%, -50%);">
    
        </div>
        <div class="mb-1 text-base font-medium text-gray-300 dark:text-brack-500 inline-flex items-center">
            
            <p class="text-sm font-medium text-gray-200 dark:text-gray-200 pr-4 overflow-hidden max-w-80">
                There is no light in the scene<br />
                Click FIX to add hemisphere. 
            </p>
            <Button
            color="primary"
            class="nob rounded bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
            onclick={() => {
                showSidebar('lightProperties');
                sceneCommand('/light hemisphere');
                $fixLight = false;
            }}
            >Fix</Button
        >
        </div>
    
    </Toast>
    </div>
{/if}

{#if $toastStore.length > MAX_TOASTS}
<div class="my-1 text-center text-xs text-gray-400">+{$toastStore.length - MAX_TOASTS} more…</div>
{/if}
{#each $toastStore.slice(-MAX_TOASTS) as toast}
<div class="my-1">
    <Toast
        dismissable={false}
        oncreate={setTimeout(() => {
            $toastStore = $toastStore.filter((t) => t !== toast);
        }, typeof toast === 'string' ? 3000 : 15000)}
        transition={fly}
        class="dark:border-dark-700 rounded-lg border-2 border-green-500 p-2 dark:bg-green-800"
        divClass="flex items-center gap-3">
        <div style="position: relative; left: 50%; transform: translate(-25%, -50%);"></div>
        <div class="mb-1 inline-flex items-center text-base font-medium text-green-700 dark:text-green-500">
            <p class="max-w-80 overflow-hidden pr-4 text-sm font-medium text-gray-500 dark:text-gray-400">
                {typeof toast === 'string' ? toast : toast.text}
            </p>
            {#if typeof toast !== 'string'}
                {#each toast.actions as entry}
                    <Button
                        color="primary"
                        class="nob ml-1 rounded bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
                        onclick={() => {
                            entry.action();
                            $toastStore = $toastStore.filter((t) => t !== toast);
                        }}>{entry.label}</Button
                    >
                {/each}
            {/if}
        </div>
    </Toast>
</div>
{/each}

</div>

<style>
    /* toasts stay clickable while the empty container area passes clicks through */
    :global(.toasts-container > div) {
        pointer-events: auto;
    }
    .toasts-container {
        position: absolute;
        top: 65px;
    }
    .cxd-hidden {
        display: none !important;
    }
    /* narrow: full-width connect bar (row 1) + logo/profile (row 2) sit above; keep
       toasts below both */
    @media (max-width: 640px) {
        .toasts-container {
            top: 124px;
        }
    }
</style>