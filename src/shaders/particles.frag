// Soft circular particle with glow
uniform vec3 uColor;
uniform float uOpacity;

void main() {
  // Circular falloff from point center
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float alpha = 1.0 - smoothstep(0.0, 1.0, d);
  alpha *= alpha; // softer falloff
  alpha *= uOpacity;

  gl_FragColor = vec4(uColor * 1.2, alpha);
}
