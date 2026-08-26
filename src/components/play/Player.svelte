<script lang="ts">
    import { T, useTask } from '@threlte/core'
    import { Vector3 } from 'three'
    import VRControls from './VRControls.svelte'
    import PointerLockControls from './PointerLockControls.svelte'
    import AvatarRig from './AvatarRig.svelte'
    import { playerCam, peerHands, worldRig, peerHandStyle } from '../../stores/sceneStore'
    import { userdata, peers } from '../../stores/appStore'
    // P2b: a peer standing in ANOTHER scene is looking at a different world, so their
    // avatar and hands have no business floating in this one. Same evidence rule as
    // the Watch gate: an unknown or unnamed scene on either side is not evidence.
    import { peerScenes, elsewhereThan } from '$lib/peerScenes'
    import { currentLevel } from '$lib/levels'
    import { handBoneSegments, handModelSegments } from '$lib/vrControls'
    import { peerHandModels, handModelCache } from '$lib/handModels'
    import { colocatedPeers, colocatedGhostHands, GHOST_HAND_OPACITY } from '$lib/colocationPresence'
    import { Text } from '@threlte/extras'

    // CO5 — A COLOCATED PEER IS RENDERED AS A GHOST, and the whole rule lives in this
    // component because it is PRESENTATION. `$colocatedPeers` is a peer id set derived
    // from "their broadcast roomKey equals MINE"; that peer is standing in front of me,
    // so their avatar body, photo card, nameplate and speaking ring would all hang in the
    // air where the real person is. Their HANDS stay (faint, and only while the local
    // `colocatedGhostHands` pref is on): a controller is where somebody is POINTING, and
    // in passthrough their real hand is visible while the virtual thing it holds is not.
    //
    // Nothing here changes what WE broadcast, and nothing here is replicated — a remote
    // peer's set is empty, so it renders both colocated users in full. That asymmetry is
    // the feature, not a bug to reconcile.

    // R-3: a peer's CUSTOM hand GLB renders rigidly at their broadcast wrist
    // pose (the hand group's pos/rot IS the wrist). Clone per side; mirror left.
    // CO5: `ghost` dims it — the materials must be CLONED first, because clone(true)
    // shares them with the cache every other peer's hands are drawn from.
    const customHand = (peerId: string, side: string, ghost = false) => {
      const hash = $peerHandModels[peerId]
      const scene = hash ? $handModelCache[hash] : null
      if (!scene) return null
      const clone = scene.clone(true)
      if (side === 'left') clone.scale.x *= -1
      if (ghost)
        clone.traverse((node: any) => {
          // gate on `.material`, never on isMesh — a Sprite has one too and would keep
          // the real material at full strength (the onion-skin lesson)
          if (!node.material) return
          const dim = (m: any) => {
            const faint = m.clone()
            faint.transparent = true
            faint.opacity = GHOST_HAND_OPACITY
            // depthWrite stays TRUE: the postprocessing passes read the depth buffer
            return faint
          }
          node.material = Array.isArray(node.material) ? node.material.map(dim) : dim(node.material)
        })
      return clone
    }

    export let position: [x: number, y: number, z: number] = [0, 0, 0]

    const handColors: Record<string, number> = { left: 0x4f83cc, right: 0xcc784f }

    // N5: split a flat wrist-local joint array [x,y,z,…] into [x,y,z] triples for
    // rendering finger-joint spheres on a hand-tracked peer
    const jointTriples = (flat: number[]): [number, number, number][] => {
      const out: [number, number, number][] = []
      for (let i = 0; i + 2 < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]])
      return out
    }

    // 195: peer avatars live in the shared CONTENT frame. This group mirrors the
    // local worldRig each frame so remote presence (broadcast in content-local
    // coords) tracks the objects when THIS viewer two-grip world-grabs. The local
    // camera rig above stays at scene-root, outside this group. Identity when unbent.
    let peerFrame: any = null
    useTask(() => {
      if (!peerFrame || !$worldRig) return
      peerFrame.position.copy($worldRig.position)
      peerFrame.quaternion.copy($worldRig.quaternion)
      peerFrame.scale.copy($worldRig.scale)
    })
  </script>
    
  <VRControls />
  <T.Group position.y={0.9}>
    <T.PerspectiveCamera
      fov={90}
      far={5000}
      bind:ref={$playerCam}
      position.x={position[0]}
      position.y={position[1]}
      position.z={position[2]}
      on:create={({ ref }) => {
        ref.lookAt(new Vector3(0, 2, 0))
      }}
    >
      <PointerLockControls />
    </T.PerspectiveCamera>
  </T.Group>

  <T.Group bind:ref={peerFrame}>
  {#each $userdata as user, i}
    {#if user[0] != $peers.peer.id && !elsewhereThan($peerScenes, $currentLevel?.name ?? '', user[0])}
    <!-- {console.log(user)} -->
      {@const colocated = $colocatedPeers.has(user[0])}
      <T.Group>
        <!-- CO5: no body, card, nameplate or speaking ring for someone in the room -->
        {#if !colocated}
          <AvatarRig {user} />
        {/if}

        <!-- VR controller markers while this peer is in a session -->
        {#if $peerHands[user[0]]?.active && (!colocated || $colocatedGhostHands)}
          {#each ['left', 'right'] as side}
            {#if $peerHands[user[0]][side]}
              {@const hand = customHand(user[0], side, colocated)}
              <T.Group
                name={`${user[0]}-hand-${side}`}
                position={$peerHands[user[0]][side].pos}
                rotation={$peerHands[user[0]][side].rot}
              >
                {#if hand}
                  <!-- R-3: the peer's chosen hand GLB, rigid at the wrist -->
                  <T is={hand} />
                {:else if $peerHands[user[0]][side].joints?.length}
                  {#if $peerHandStyle === 'model'}
                    <!-- R-3: rounded capsule hand — same bones, per-bone radii -->
                    {#each handModelSegments($peerHands[user[0]][side].joints) as b}
                      <T.Mesh position={b.pos} rotation={b.rot}>
                        <T.CapsuleGeometry args={[b.r, Math.max(b.len - b.r, 0.004), 3, 8]} />
                        <T.MeshStandardMaterial
                          color={handColors[side]}
                          roughness={0.7}
                          transparent={colocated}
                          opacity={colocated ? GHOST_HAND_OPACITY : 1}
                        />
                      </T.Mesh>
                    {/each}
                  {:else if $peerHandStyle === 'hands'}
                    <!-- B2.3: cuboid-bone hand — ~24 box segments between the joints -->
                    {#each handBoneSegments($peerHands[user[0]][side].joints) as b}
                      <T.Mesh position={b.pos} rotation={b.rot}>
                        <T.BoxGeometry args={[0.009, b.len, 0.009]} />
                        <T.MeshStandardMaterial
                          color={handColors[side]}
                          transparent={colocated}
                          opacity={colocated ? GHOST_HAND_OPACITY : 1}
                        />
                      </T.Mesh>
                    {/each}
                  {:else}
                    <!-- N5: sphere-per-joint style (setting: peerHandStyle) -->
                    {#each jointTriples($peerHands[user[0]][side].joints) as p}
                      <T.Mesh position={p}>
                        <T.SphereGeometry args={[0.008, 8, 8]} />
                        <T.MeshStandardMaterial
                          color={handColors[side]}
                          transparent={colocated}
                          opacity={colocated ? GHOST_HAND_OPACITY : 1}
                        />
                      </T.Mesh>
                    {/each}
                  {/if}
                {:else}
                  <T.Mesh>
                    <T.BoxGeometry args={[0.06, 0.06, 0.14]} />
                    <T.MeshStandardMaterial
                      color={handColors[side]}
                      transparent={colocated}
                      opacity={colocated ? GHOST_HAND_OPACITY : 1}
                    />
                  </T.Mesh>
                  <!-- short pointer so the aiming direction is readable -->
                  <T.Mesh position={[0, 0, -0.12]} rotation={[Math.PI / 2, 0, 0]}>
                    <T.CylinderGeometry args={[0.006, 0.006, 0.1]} />
                    <T.MeshStandardMaterial
                      color={0xffffff}
                      transparent={colocated}
                      opacity={colocated ? GHOST_HAND_OPACITY : 1}
                    />
                  </T.Mesh>
                {/if}
              </T.Group>
            {/if}
          {/each}
        {/if}
      </T.Group>
      {/if}
  {/each}
  </T.Group>