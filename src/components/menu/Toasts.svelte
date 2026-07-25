<script lang="ts">
    import { peers, loading, loadingcount, pendingApprovals, waitingForApproval, userdata, toastStore, fixLight, showSidebar, specatorMode, restorePanels, appNotice, connectDrawerOpen, toastsInDrawerOnly } from '../../stores/appStore'
    import { restoreAvailable, restoreSnapshot, dismissRestore } from '$lib/autosave'
    import { cancelOutboundRequest } from '$lib/peerApproval'
    import { rolesInfo } from '$lib/cloudHooks'
    import { sceneCommand } from '$lib/commandsHandler.svelte';
	import { objectsGroup, camSave, globalCamera, globalScene } from '../../stores/sceneStore.js';
	import { Progressbar, Toast, Button } from 'flowbite-svelte';
    import { fly } from 'svelte/transition';

let showToast = $state(false);

// CN toast routing. The viewport containers are HIDDEN (display:none, not removed —
// so each toast's expiry timer keeps running) and the live toasts instead render in
// the drawer's Toasts tab:
//  - approval requests hide from the viewport when the drawer body is OPEN (they show
//    in the Toasts tab; a "new request" cue appears in the drawer header). When the
//    drawer is closed they always pop in the viewport so they're never missed.
//  - informational toasts hide when the drawer is open OR when the user opted into
//    "toasts in the drawer only".
const hideCritical = $derived($connectDrawerOpen || $toastsInDrawerOnly);
const hideRegular = $derived($connectDrawerOpen || $toastsInDrawerOnly);

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

// Approve an incoming connection request. `role` (cloud roles) optionally grants the
// joiner a role right away — "Approve + edit" makes them an editor instead of the
// default viewer. A 'retry' request just re-establishes an existing whitelisted conn.
function approvePeer(approval, role) {
    $pendingApprovals = $pendingApprovals.filter((p) => p.peerId !== approval.peerId);
    if (approval.status === 'retry') {
        try { $peers.connections[approval.peerId]?.close(); } catch {}
    } else {
        $userdata.push([approval.peerId, '', '']);
    }
    $peers.send({ type: 'userdata', userdata: $userdata });
    $peers.connectToPeer(approval.peerId, true);
    if (role && $rolesInfo?.setRole) $rolesInfo.setRole(approval.peerId, role);
}
function rejectPeer(approval) {
    $pendingApprovals = $pendingApprovals.filter((p) => p.peerId !== approval.peerId);
    try { $peers.connections[approval.peerId]?.close?.(); } catch {}
}
</script>
<!-- E1: CRITICAL container — connection requests + pending outbound requests stay
     ABOVE modals (--z-toast) so an approval is never missed while a modal is open. -->
<div class="my-4 toasts-container toasts-critical"
class:cxd-hidden={hideCritical}
style="left: 50%; max-width: 500px; transform: translate(-50%, 0%); z-index: var(--z-toast); pointer-events: none;"
>
{#each $pendingApprovals as approval}
<div class="my-1 cxreq" transition:fly={{ y: -8, duration: 180 }}>
    <div class="cxreq-row">
        <div class="cxreq-text">
            <span class="cxreq-title">Connection request, approve?</span>
            <span class="cxreq-id">{String(approval.peerId).slice(0, 6).toUpperCase()}</span>
        </div>
        <div class="cxreq-actions">
            {#if $rolesInfo}
                <button class="cxreq-btn cxreq-view" onclick={() => approvePeer(approval, null)} title="Approve as a view-only viewer">View only</button>
                {#if approval.status !== 'retry'}
                    <button class="cxreq-btn cxreq-editor" onclick={() => approvePeer(approval, 'editor')} title="Approve and grant edit access">Editor access</button>
                {/if}
            {:else}
                <button class="cxreq-btn cxreq-editor" onclick={() => approvePeer(approval, null)}>Approve</button>
            {/if}
            <button class="cxreq-btn cxreq-reject" onclick={() => rejectPeer(approval)} title="Decline">Reject</button>
        </div>
    </div>
</div>
{/each}

<!-- CN: the OUTBOUND "Connection request to peer / pending" toast was removed — the
     Connect pill already shows the "Waiting for approval…" state + a Cancel button, so
     the toast was redundant chrome. Incoming approval requests (above) still toast. -->
</div>

<!-- pointer-events: none lets clicks pass through the (invisible) container area;
     each toast re-enables them for itself. REGULAR container: info/decision toasts
     sit BELOW modals (--z-toast-low) so Settings/Modules/Sessions cover them. -->
<div class="my-4 toasts-container toasts-regular"
class:cxd-hidden={hideRegular}
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
    /* connection-request card — on-scheme (dark surface; buttons match role colours:
       viewer=gray, editor=blue) with the text + actions on ONE row. */
    .cxreq {
        pointer-events: auto;
        width: min(420px, 94vw);
        margin: 4px auto 0;
        background: var(--color-form, rgb(31 41 55 / 0.98));
        border: 1px solid rgb(255 255 255 / 0.1);
        border-radius: 12px;
        padding: 8px 10px;
        box-shadow: 0 12px 30px rgb(0 0 0 / 0.4);
        backdrop-filter: blur(6px);
    }
    .cxreq-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .cxreq-text { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex: 1 1 auto; }
    .cxreq-title { font-size: 12px; color: #e5e7eb; }
    .cxreq-id { font-size: 11px; color: #9ca3af; font-family: ui-monospace, monospace; }
    .cxreq-actions { display: flex; gap: 6px; flex: 0 0 auto; }
    .cxreq-btn { font-size: 11px; padding: 4px 10px; border-radius: 7px; border: 0; cursor: pointer; color: #fff; white-space: nowrap; }
    .cxreq-view { background: #6b7280; }
    .cxreq-view:hover { background: #7b8494; }
    .cxreq-editor { background: #2563eb; }
    .cxreq-editor:hover { background: #1d4ed8; }
    .cxreq-reject { background: transparent; border: 1px solid rgb(248 113 113 / 0.4); color: #f87171; }
    .cxreq-reject:hover { background: rgb(220 38 38 / 0.15); }
    /* narrow: full-width connect bar (row 1) + logo/profile (row 2) sit above; keep
       toasts below both */
    @media (max-width: 640px) {
        .toasts-container {
            top: 124px;
        }
    }
</style>