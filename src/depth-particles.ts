/**
 * Multi-layer particle system — 3 depth layers with different
 * sizes, speeds, and counts for parallax depth perception.
 *
 * Far:  many tiny slow particles (dust in the distance)
 * Mid:  moderate particles (atmosphere)
 * Near: few large fast particles (passing close to camera)
 */

import * as THREE from 'three';

interface ParticleLayerConfig {
  count: number;
  zRange: [number, number];   // min/max Z spawn range
  spread: number;              // XY spread
  size: number;                // base size
  speed: number;               // Z drift speed (toward camera)
  drift: number;               // XY wander speed
  opacity: number;             // base opacity
}

const LAYER_CONFIGS: ParticleLayerConfig[] = [
  // Far — tiny dust, slow drift
  { count: 120, zRange: [-8, -3], spread: 8, size: 0.008, speed: 0.003, drift: 0.001, opacity: 0.25 },
  // Mid — the "main" particle layer
  { count: 80, zRange: [-5, -1], spread: 6, size: 0.02, speed: 0.007, drift: 0.002, opacity: 0.35 },
  // Near — few large particles floating past
  { count: 20, zRange: [-2, 0.5], spread: 4, size: 0.06, speed: 0.015, drift: 0.003, opacity: 0.15 },
];

interface ParticleLayer {
  mesh: THREE.Points;
  geometry: THREE.BufferGeometry;
  positions: Float32Array;
  velocities: Float32Array;
  config: ParticleLayerConfig;
}

export class DepthParticles {
  private layers: ParticleLayer[] = [];
  /** The group containing all particle layers — add to scene */
  readonly group: THREE.Group;

  constructor() {
    this.group = new THREE.Group();

    for (const config of LAYER_CONFIGS) {
      const layer = this.createLayer(config);
      this.layers.push(layer);
      this.group.add(layer.mesh);
    }
  }

  private createLayer(config: ParticleLayerConfig): ParticleLayer {
    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(config.count * 3);
    const velocities = new Float32Array(config.count * 3);

    for (let i = 0; i < config.count; i++) {
      const i3 = i * 3;
      positions[i3] = (Math.random() - 0.5) * config.spread;
      positions[i3 + 1] = (Math.random() - 0.5) * config.spread;
      positions[i3 + 2] = config.zRange[0] + Math.random() * (config.zRange[1] - config.zRange[0]);

      velocities[i3] = (Math.random() - 0.5) * config.drift;
      velocities[i3 + 1] = (Math.random() - 0.5) * config.drift;
      // Positive Z = toward camera (coming at you from the tunnel depth)
      velocities[i3 + 2] = config.speed * (0.8 + Math.random() * 0.4);
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

    const material = new THREE.PointsMaterial({
      size: config.size,
      color: new THREE.Color(0.6, 0.3, 0.9),
      transparent: true,
      opacity: config.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      sizeAttenuation: true,
    });

    const mesh = new THREE.Points(geometry, material);
    return { mesh, geometry, positions, velocities, config };
  }

  /** Set particle color across all layers */
  setColor(r: number, g: number, b: number): void {
    for (const layer of this.layers) {
      (layer.mesh.material as THREE.PointsMaterial).color.setRGB(r, g, b);
    }
  }

  /** Update all layers — call every frame */
  update(intensity: number, time: number, opacityMult = 1, sizeMult = 1): void {
    for (const layer of this.layers) {
      const mat = layer.mesh.material as THREE.PointsMaterial;
      mat.opacity = layer.config.opacity * (0.4 + intensity * 0.6) * opacityMult;
      mat.size = layer.config.size * (0.8 + intensity * 0.4) * sizeMult;

      const { positions, velocities, config } = layer;
      const count = config.count;

      for (let i = 0; i < count; i++) {
        const i3 = i * 3;
        positions[i3] += velocities[i3];
        positions[i3 + 1] += velocities[i3 + 1] + Math.sin(time * 0.5 + i * 0.1) * config.drift * 0.3;
        positions[i3 + 2] += velocities[i3 + 2];

        // Reset particles that pass the camera — respawn at far (deep) end
        if (positions[i3 + 2] > config.zRange[1] + 1 || positions[i3 + 2] < config.zRange[0] - 1) {
          positions[i3] = (Math.random() - 0.5) * config.spread;
          positions[i3 + 1] = (Math.random() - 0.5) * config.spread;
          positions[i3 + 2] = config.zRange[0]; // respawn at far (deep) end
        }

        // Reset particles that drift too far horizontally
        if (Math.abs(positions[i3]) > config.spread || Math.abs(positions[i3 + 1]) > config.spread) {
          positions[i3] = (Math.random() - 0.5) * config.spread * 0.5;
          positions[i3 + 1] = (Math.random() - 0.5) * config.spread * 0.5;
        }
      }

      layer.geometry.attributes.position.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const layer of this.layers) {
      layer.geometry.dispose();
      (layer.mesh.material as THREE.Material).dispose();
    }
  }
}
