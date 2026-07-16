<script lang="ts">
    import { T, useTask } from '@threlte/core'
    import { Vector3 } from 'three'
    import VRControls from './VRControls.svelte'
    import PointerLockControls from './PointerLockControls.svelte'
    import AvatarRig from './AvatarRig.svelte'
    import { playerCam, peerHands, worldRig, peerHandStyle } from '../../stores/sceneStore'
    import { userdata, peers } from '../../stores/appStore'
    import { handBoneSegments } from '$lib/vrControls'
    import { Text } from '@threlte/extras'

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
    {#if user[0] != $peers.peer.id}
    <!-- {console.log(user)} -->
      <T.Group>
        <AvatarRig {user} />

        <!-- VR controller markers while this peer is in a session -->
        {#if $peerHands[user[0]]?.active}
          {#each ['left', 'right'] as side}
            {#if $peerHands[user[0]][side]}
              <T.Group
                name={`${user[0]}-hand-${side}`}
                position={$peerHands[user[0]][side].pos}
                rotation={$peerHands[user[0]][side].rot}
              >
                {#if $peerHands[user[0]][side].joints?.length}
                  {#if $peerHandStyle === 'hands'}
                    <!-- B2.3: cuboid-bone hand — ~24 box segments between the joints -->
                    {#each handBoneSegments($peerHands[user[0]][side].joints) as b}
                      <T.Mesh position={b.pos} rotation={b.rot}>
                        <T.BoxGeometry args={[0.009, b.len, 0.009]} />
                        <T.MeshStandardMaterial color={handColors[side]} />
                      </T.Mesh>
                    {/each}
                  {:else}
                    <!-- N5: sphere-per-joint style (setting: peerHandStyle) -->
                    {#each jointTriples($peerHands[user[0]][side].joints) as p}
                      <T.Mesh position={p}>
                        <T.SphereGeometry args={[0.008, 8, 8]} />
                        <T.MeshStandardMaterial color={handColors[side]} />
                      </T.Mesh>
                    {/each}
                  {/if}
                {:else}
                  <T.Mesh>
                    <T.BoxGeometry args={[0.06, 0.06, 0.14]} />
                    <T.MeshStandardMaterial color={handColors[side]} />
                  </T.Mesh>
                  <!-- short pointer so the aiming direction is readable -->
                  <T.Mesh position={[0, 0, -0.12]} rotation={[Math.PI / 2, 0, 0]}>
                    <T.CylinderGeometry args={[0.006, 0.006, 0.1]} />
                    <T.MeshStandardMaterial color={0xffffff} />
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