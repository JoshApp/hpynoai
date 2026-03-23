// Milkdrop-style feedback warp
// Reads the previous frame, warps it toward center with zoom + rotation,
// then blends with the fresh tunnel render.

uniform sampler2D uPrevFrame;   // previous accumulated frame
uniform sampler2D uFreshFrame;  // current tunnel render
uniform float uZoom;            // how much to pull toward center (0.01-0.03)
uniform float uRotation;        // per-frame rotation in radians
uniform float uDecay;           // how fast old frames fade (0.92-0.98)
uniform float uBlend;           // fresh frame blend strength (0.3-0.6)
uniform float uTime;
uniform float uIntensity;
uniform vec2 uResolution;

varying vec2 vUv;

void main() {
  vec2 uv = vUv;
  vec2 center = vec2(0.5);

  // Warp the previous frame: zoom toward center + slight rotation
  vec2 offset = uv - center;

  // Zoom — pull everything inward
  float zoom = 1.0 - uZoom;
  offset *= zoom;

  // Rotation — very subtle twist
  float s = sin(uRotation);
  float c = cos(uRotation);
  offset = vec2(
    offset.x * c - offset.y * s,
    offset.x * s + offset.y * c
  );

  vec2 warpedUV = center + offset;

  // Sample previous frame with warp applied
  vec3 prev = texture2D(uPrevFrame, warpedUV).rgb;

  // Decay old frames — they dim over time
  prev *= uDecay;

  // Edge fade — prevent artifacts at screen borders
  vec2 edgeDist = smoothstep(vec2(0.0), vec2(0.08), warpedUV)
                * smoothstep(vec2(0.0), vec2(0.08), vec2(1.0) - warpedUV);
  float edgeMask = edgeDist.x * edgeDist.y;
  prev *= edgeMask;

  // Sample fresh tunnel render
  vec3 fresh = texture2D(uFreshFrame, uv).rgb;

  // Blend: use max-based mix instead of additive to prevent blowout.
  // The fresh frame is the "truth", feedback trails add ghostly depth behind it.
  vec3 result = mix(prev, fresh, uBlend);

  gl_FragColor = vec4(result, 1.0);
}
