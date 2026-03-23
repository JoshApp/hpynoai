// GPU-driven particles — all animation in the vertex shader.
// Each particle has a seed (random ID) stored in an attribute.
// Position, velocity, and reset are computed from time + seed.
// Zero CPU cost per frame.

attribute float aSeed;   // unique random seed per particle [0-1]

uniform float uTime;
uniform float uIntensity;
uniform float uSize;
uniform float uSpeedMult;

// Hash function for deterministic randomness from seed
float hash(float n) { return fract(sin(n * 78.233) * 43758.5453); }

void main() {
  float seed = aSeed;

  // Derive particle properties from seed
  float h1 = hash(seed);
  float h2 = hash(seed + 1.0);
  float h3 = hash(seed + 2.0);
  float h4 = hash(seed + 3.0);
  float h5 = hash(seed + 4.0);

  // Spread: how far from center (XY)
  float spread = 4.0 + h4 * 6.0; // 4-10 units
  float startX = (h1 - 0.5) * spread;
  float startY = (h2 - 0.5) * spread;

  // Z travel: particles spawn deep and fly toward camera
  float zSpeed  = (0.3 + h3 * 0.7) * uSpeedMult; // variable speed
  float zCycle  = 12.0 / zSpeed; // time for full cycle
  float zOffset = h5 * zCycle;   // stagger start times
  float zPhase  = mod(uTime + zOffset, zCycle) / zCycle; // 0→1 along path

  float zStart = -10.0;
  float zEnd   = 2.0;
  float z      = zStart + zPhase * (zEnd - zStart);

  // Gentle XY drift
  float driftX = sin(uTime * 0.3 + seed * 50.0) * 0.3;
  float driftY = cos(uTime * 0.25 + seed * 37.0) * 0.3;

  vec3 pos = vec3(startX + driftX, startY + driftY, z);

  // Size: closer particles are bigger
  float depthFade = smoothstep(-10.0, 0.0, z);
  float size = uSize * (0.3 + depthFade * 0.7) * (0.5 + h3 * 1.0);

  // Fade in near spawn, fade out near camera
  float fadeIn  = smoothstep(zStart, zStart + 2.0, z);
  float fadeOut = 1.0 - smoothstep(zEnd - 1.5, zEnd, z);

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;
  gl_PointSize = size * (300.0 / -mvPos.z) * fadeIn * fadeOut;
}
