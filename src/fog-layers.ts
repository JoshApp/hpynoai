/**
 * Volumetric fog — single fullscreen plane with all 3 layers
 * computed in one shader pass. Additive blending, very cheap.
 */

import * as THREE from 'three';
import fogVert from './shaders/fog.vert';
import fogFrag from './shaders/fog.frag';

export class FogLayers {
  private mesh: THREE.Mesh;
  private material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: fogVert,
      fragmentShader: fogFrag,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTime: { value: 0 },
        uDensity: { value: 1.0 },
        uBreathValue: { value: 0 },
        uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
        uColorFar: { value: new THREE.Vector3(0.3, 0.15, 0.5) },
        uColorMid: { value: new THREE.Vector3(0.4, 0.2, 0.6) },
        uColorNear: { value: new THREE.Vector3(0.5, 0.25, 0.7) },
      },
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), this.material);
    this.mesh.position.z = -1.5;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 10;
  }

  addTo(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  removeFrom(scene: THREE.Scene): void {
    scene.remove(this.mesh);
  }

  setColors(
    primary: [number, number, number],
    accent: [number, number, number],
    bg: [number, number, number],
  ): void {
    const u = this.material.uniforms;
    u.uColorFar.value.set(bg[0] * 0.8 + primary[0] * 0.2, bg[1] * 0.8 + primary[1] * 0.2, bg[2] * 0.8 + primary[2] * 0.2);
    u.uColorMid.value.set(primary[0] * 0.6 + accent[0] * 0.4, primary[1] * 0.6 + accent[1] * 0.4, primary[2] * 0.6 + accent[2] * 0.4);
    u.uColorNear.value.set(accent[0] * 0.7 + primary[0] * 0.3, accent[1] * 0.7 + primary[1] * 0.3, accent[2] * 0.7 + primary[2] * 0.3);
  }

  update(time: number, breathValue: number, intensity: number): void {
    const u = this.material.uniforms;
    u.uTime.value = time;
    u.uBreathValue.value = breathValue;
    u.uDensity.value = 0.5 + intensity * 0.5;
  }

  resize(width: number, height: number): void {
    this.material.uniforms.uResolution.value.set(width, height);
  }

  dispose(): void {
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
