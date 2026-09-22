/**
 * GPU particles — position, size, and fade all derived in the vertex
 * shader from a per-particle seed and time. Zero per-frame CPU work.
 */

import * as THREE from 'three';
import particlesVert from '../shaders/particles.vert';
import particlesFrag from '../shaders/particles.frag';

export class GpuParticles {
  readonly mesh: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly u = {
    uTime: { value: 0 },
    uIntensity: { value: 0 },
    uSize: { value: 3 },
    uSpeedMult: { value: 1 },
    uColor: { value: new THREE.Vector3(0.9, 0.6, 0.65) },
    uOpacity: { value: 0.4 },
  };

  constructor(count = 300) {
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) seeds[i] = i / count + Math.random() * (1 / count);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: particlesVert,
      fragmentShader: particlesFrag,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: this.u,
    });
    this.mesh = new THREE.Points(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  setColor(r: number, g: number, b: number): void { this.u.uColor.value.set(r, g, b); }

  update(time: number, intensity: number, opacityMult = 1, sizeMult = 1): void {
    this.u.uTime.value = time;
    this.u.uIntensity.value = intensity;
    this.u.uOpacity.value = (0.2 + intensity * 0.4) * opacityMult;
    this.u.uSize.value = (2 + intensity * 2) * sizeMult;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
