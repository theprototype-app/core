<script lang="ts">
	import { Info } from '@lucide/svelte';
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

// professional toast card: manual close (✕) + auto-dismiss timer (kept from before)
function dismiss(toast: any) {
    $toastStore = $toastStore.filter((t) => t !== toast);
}
function autoDismiss(node: any, toast: any) {
    const id = setTimeout(() => dismiss(toast), typeof toast === 'string' ? 5000 : 15000);
    return { destroy() { clearTimeout(id); } };
}

// flowbite 1.x modals are native <dialog> TOP-LAYER — no z-index can beat them.
// The critical container is therefore a MANUAL POPOVER: shown while approvals are
// pending, it enters the top layer AFTER any open dialog and stacks above it, so
// a connection request is still never missed behind a modal (the E1 guarantee).
let criticalEl = $state<any>(null);
$effect(() => {
	const wanted = $pendingApprovals.length > 0 && !hideCritical;
	const el = criticalEl;
	if (!el || typeof el.showPopover !== 'function') return;
	try {
		if (wanted && !el.matches(':popover-open')) el.showPopover();
		else if (!wanted && el.matches(':popover-open')) el.hidePopover();
	} catch {
		/* popover quirks (detached el) — the container still renders in-page */
	}
});
</script>
<!-- E1: CRITICAL container — connection requests + pending outbound requests stay
     ABOVE modals (top-layer popover, see above) so an approval is never missed. -->
<div class="my-4 toasts-container toasts-critical"
popover="manual"
bind:this={criticalEl}
class:cxd-hidden={hideCritical}
style="max-width: 500px; pointer-events: none;"
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
	<Progressbar progress={100 * (($loadingcount-$loading.length) - 0) / ($loadingcount - 0)} color="green" />
</Toast>
{/if}
{/if}


{#if $restoreAvailable}
<div class="my-1">
    <Toast dismissable={false} transition={fly} class="flex items-center gap-3 p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700 border-2 border-blue-500">
        <div style="position: relative; left: 50%; transform: translate(-25%, -50%);"></div>
        <div class="mb-1 inline-flex items-center text-base font-medium">
            <p class="max-w-80 overflow-hidden pr-4 text-sm font-medium text-gray-500 dark:text-gray-200">
                Restore previous session?<br />
                {$restoreAvailable.objects} objects, saved {new Date($restoreAvailable.ts).toLocaleTimeString()}
            </p>
            <Button
                color="primary"
                class="nob rounded-sm bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
                onclick={() => restoreSnapshot()}>Restore</Button
            >
            <Button
                color="alternative"
                class="nob ml-2 rounded-sm"
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
    <Toast  transition={fly} class="flex items-center gap-3 p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700 border-2 border-blue-500" onclose={() =>
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
            class="nob rounded-sm bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
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
    <Toast dismissable={false} transition={fly} class="flex items-center gap-3 p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700 border-2 border-red-500" onclose={() => 
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
            class="nob rounded-sm bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
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
    <Toast  transition={fly} class="flex items-center gap-3 p-2 rounded-lg dark:bg-gray-700 dark:border-dark-700 border-2 border-red-500" onclose={() => 
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
            class="nob rounded-sm bg-blue-500 text-white dark:bg-green-600 dark:text-gray-200 dark:hover:bg-green-700"
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
<!-- keyed by the entry (dedupe keeps plain strings unique; action toasts are
     distinct objects): an UNKEYED each reuses rows here, so a neighbour's expiry
     migrated text across nodes and svelte 5.5x left a stuck duplicate behind -->
{#each $toastStore.slice(-MAX_TOASTS) as toast (toast)}
<div class="my-1 tp-toast" transition:fly={{ y: -8, duration: 180 }} use:autoDismiss={toast}>
    <button class="tp-toast-x" title="Dismiss" aria-label="Dismiss" onclick={() => dismiss(toast)}>✕</button>
    <div class="tp-toast-body">
        <Info size={16} class="tp-toast-icon" aria-hidden="true" />
        <div class="tp-toast-main">
            <div class="tp-toast-text">{typeof toast === 'string' ? toast : toast.text}</div>
            {#if typeof toast !== 'string' && toast.actions?.length}
                <div class="tp-toast-actions">
                    {#each toast.actions as entry}
                        <button class="tp-toast-action" onclick={() => { entry.action(); dismiss(toast); }}>{entry.label}</button>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
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
    /* the critical container is a manual POPOVER (top layer, above native dialogs);
       reset the UA popover styles and keep the old centered-under-the-bar placement */
    .toasts-critical[popover] {
        position: fixed;
        inset: auto;
        top: 65px;
        left: 50%;
        transform: translate(-50%, 0);
        margin: 0;
        border: 0;
        padding: 0;
        background: transparent;
        overflow: visible;
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
    /* professional notification toast (replaces the flowbite green toast) */
    .tp-toast {
        pointer-events: auto;
        position: relative;
        width: min(420px, 94vw);
        margin: 0 auto;
        background: var(--color-form, rgb(31 41 55 / 0.98));
        border: 1px solid rgb(255 255 255 / 0.1);
        border-left: 3px solid #60a5fa;
        border-radius: 12px;
        padding: 10px 32px 10px 12px;
        box-shadow: 0 12px 30px rgb(0 0 0 / 0.4);
        backdrop-filter: blur(6px);
    }
    .tp-toast-body { display: flex; align-items: flex-start; gap: 9px; }
    /* the icon is a lucide component's svg (outside this component's scope hash) */
    .tp-toast-body :global(.tp-toast-icon) { color: #60a5fa; margin-top: 1px; flex: 0 0 auto; }
    .tp-toast-main { min-width: 0; flex: 1 1 auto; }
    .tp-toast-text { font-size: 12.5px; color: #e5e7eb; line-height: 1.4; }
    .tp-toast-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 6px; }
    .tp-toast-action { font-size: 11px; color: #93c5fd; background: transparent; border: 0; cursor: pointer; padding: 0; text-decoration: underline; }
    .tp-toast-action:hover { color: #bfdbfe; }
    .tp-toast-x {
        position: absolute; top: 7px; right: 7px; width: 20px; height: 20px;
        border: 0; background: transparent; color: rgb(156 163 175); cursor: pointer;
        font-size: 11px; line-height: 1; border-radius: 6px;
    }
    .tp-toast-x:hover { color: #fff; background: rgb(255 255 255 / 0.08); }
    /* narrow: full-width connect bar (row 1) + logo/profile (row 2) sit above; keep
       toasts below both */
    @media (max-width: 640px) {
        .toasts-container {
            top: 124px;
        }
    }
</style>