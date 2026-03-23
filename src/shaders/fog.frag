// Volumetric fog — all 3 depth layers in a single pass.
// 2-octave noise (was 4), one draw call (was 3).

uniform float uTime;
uniform float uDensity;     // global density scale
uniform float uBreathValue;
uniform vec2 uResolution;
uniform vec3 uColorFar;
uniform vec3 uColorMid;
uniform vec3 uColorNear;

varying vec2 vUv;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

// 2-octave FBM — half the cost of 4-octave, still wispy
float fbm2(vec2 p) {
  return noise(p) * 0.6 + noise(p * 2.0 + vec2(100.0)) * 0.4;
}

void main() {
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  uv.x *= aspect;

  // Radial fade — fog at edges, clear center
  vec2 c = (vUv - 0.5) * vec2(aspect, 1.0);
  float r = length(c) * 2.0;
  float radial = smoothstep(0.15, 0.8, r);

  float brMod = 0.85 + (1.0 - uBreathValue) * 0.15;

  // Far layer — barely there wisps, just enough to break uniformity
  float far  = fbm2(uv * 1.5 + vec2(uTime * 0.02, uTime * 0.015));
  far = smoothstep(0.4, 0.7, far) * 0.012;

  // Mid layer
  float mid  = fbm2(uv * 2.5 - vec2(uTime * 0.04, uTime * 0.03) + vec2(5.0));
  mid = smoothstep(0.4, 0.7, mid) * 0.008;

  // Near layer
  float near = fbm2(uv * 4.0 + vec2(uTime * 0.07, uTime * 0.05) + vec2(10.0));
  near = smoothstep(0.4, 0.7, near) * 0.005;

  // Combine — each layer tinted separately
  vec3 fog = uColorFar * far + uColorMid * mid + uColorNear * near;
  fog *= radial * uDensity * brMod;

  gl_FragColor = vec4(fog, 1.0);
}
