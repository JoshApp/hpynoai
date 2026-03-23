import * as THREE from 'three';

/**
 * Floating particle system — adds ambient depth and atmosphere
 */
export class ParticleField {
  public mesh: THREE.Points;
  private geometry: THREE.BufferGeometry;
  private positions: Float32Array;
  private velocities: Float32Array;
  private count: number;

  constructor(count = 600) {
    this.count = count;
    this.geometry = new THREE.BufferGeometry();
    this.positions = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
      const i3 = i * 3;
      this.positions[i3] = (Math.random() - 0.5) * 10;
      this.positions[i3 + 1] = (Math.random() - 0.5) * 10;
      this.positions[i3 + 2] = -Math.random() * 10; // spread into the tunnel (negative Z)

      this.velocities[i3] = (Math.random() - 0.5) * 0.003;
      this.velocities[i3 + 1] = (Math.random() - 0.5) * 0.003;
      this.velocities[i3 + 2] = 0.005 + Math.random() * 0.01; // fly toward camera (positive Z)
    }

    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));

    const material = new THREE.PointsMaterial({
      size: 0.02,
      color: new THREE.Color(0.6, 0.3, 0.9),
      transparent: true,
      opacity: 0.4,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });

    this.mesh = new THREE.Points(this.geometry, material);
  }

  update(intensity: number, time: number, opacityMult = 1, sizeMult = 1): void {
    const material = this.mesh.material as THREE.PointsMaterial;
    material.opacity = (0.2 + intensity * 0.5) * opacityMult;
    material.size = (0.02 + intensity * 0.03) * sizeMult;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;
      this.positions[i3] += this.velocities[i3];
      this.positions[i3 + 1] += this.velocities[i3 + 1] + Math.sin(time + i) * 0.0005;
      this.positions[i3 + 2] += this.velocities[i3 + 2];

      // Reset particles that pass the camera — respawn deep in tunnel
      if (this.positions[i3 + 2] > 2 || this.positions[i3 + 2] < -10) {
        this.positions[i3] = (Math.random() - 0.5) * 10;
        this.positions[i3 + 1] = (Math.random() - 0.5) * 10;
        this.positions[i3 + 2] = -8 - Math.random() * 2; // respawn far in tunnel
      }
    }

    this.geometry.attributes.position.needsUpdate = true;
  }
}
