/**
 * GPU Particles — all animation runs in the vertex shader.
 * Zero per-frame CPU cost. Replaces both ParticleField and DepthParticles.
 *
 * Each particle has a random seed attribute. The vertex shader uses
 * the seed + time to compute position, size, and fade deterministically.
 */

import * as THREE from 'three';
import particlesVert from './shaders/particles.vert';
import particlesFrag from './shaders/particles.frag';

export class GpuParticles {
  readonly mesh: THREE.Points;
  private material: THREE.ShaderMaterial;

  constructor(count = 250) {
    const seeds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      seeds[i] = i / count + Math.random() * (1 / count); // evenly distributed with jitter
    }

    const geometry = new THREE.BufferGeometry();
    // Dummy position attribute (required by Three.js, overridden in vertex shader)
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: particlesVert,
      fragmentShader: particlesFrag,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uIntensity: { value: 0 },
        uSize: { value: 3.0 },
        uSpeedMult: { value: 1.0 },
        uColor: { value: new THREE.Vector3(0.6, 0.3, 0.9) },
        uOpacity: { value: 0.4 },
      },
    });

    this.mesh = new THREE.Points(geometry, this.material);
    this.mesh.frustumCulled = false;
  }

  setColor(r: number, g: number, b: number): void {
    this.material.uniforms.uColor.value.set(r, g, b);
  }

  update(time: number, intensity: number, opacityMult = 1, sizeMult = 1): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uIntensity.value = intensity;
    u.uOpacity.value = (0.2 + intensity * 0.4) * opacityMult;
    u.uSize.value = (2.0 + intensity * 2.0) * sizeMult;
  }

  // ── Telemetry ──
  getState(): { intensity: number; size: number; speedMult: number; opacity: number; color: [number, number, number] } {
    const u = this.material.uniforms;
    const c = u.uColor.value;
    return {
      intensity: u.uIntensity.value,
      size: u.uSize.value,
      speedMult: u.uSpeedMult.value,
      opacity: u.uOpacity.value,
      color: [c.x, c.y, c.z],
    };
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
