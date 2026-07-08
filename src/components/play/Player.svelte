<script lang="ts">
    import { T } from '@threlte/core'
    import { Vector3 } from 'three'
    import VRControls from './VRControls.svelte'
    import PointerLockControls from './PointerLockControls.svelte'
    import { playerCam, peerHands } from '../../stores/sceneStore'
    import { userdata, peers } from '../../stores/appStore'
    import { Text } from '@threlte/extras'

    export let position: [x: number, y: number, z: number] = [0, 0, 0]

    const handColors: Record<string, number> = { left: 0x4f83cc, right: 0xcc784f }
  </script>
    
  <VRControls />
  <T.Group position.y={0.9}>
    <T.PerspectiveCamera
      fov={90}
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

  {#each $userdata as user, i}
    {#if user[0] != $peers.peer.id}
    <!-- {console.log(user)} -->
      <T.Group>
        <T.Mesh
          position={[0, 1000, 0]}
          scale={[1, 1, 1]}
          castShadow
          name={user[0]}
        >
          <Text
            color="black"
            fontSize={0.2}
            anchorX="center"
            position={[0, 0.15, -0.52]}
            rotation={[0, Math.PI, 0]}
            text={user[0]}
          />
          <T.SphereGeometry args={[0.59, 6]} />
          <T.MeshNormalMaterial />
        </T.Mesh>

        <!-- VR controller markers while this peer is in a session -->
        {#if $peerHands[user[0]]?.active}
          {#each ['left', 'right'] as side}
            {#if $peerHands[user[0]][side]}
              <T.Group
                name={`${user[0]}-hand-${side}`}
                position={$peerHands[user[0]][side].pos}
                rotation={$peerHands[user[0]][side].rot}
              >
                <T.Mesh>
                  <T.BoxGeometry args={[0.06, 0.06, 0.14]} />
                  <T.MeshStandardMaterial color={handColors[side]} />
                </T.Mesh>
                <!-- short pointer so the aiming direction is readable -->
                <T.Mesh position={[0, 0, -0.12]} rotation={[Math.PI / 2, 0, 0]}>
                  <T.CylinderGeometry args={[0.006, 0.006, 0.1]} />
                  <T.MeshStandardMaterial color={0xffffff} />
                </T.Mesh>
              </T.Group>
            {/if}
          {/each}
        {/if}
      </T.Group>
      {/if}
  {/each}