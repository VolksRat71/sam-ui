#version 300 es
// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Outline pass 1 of 3: up to three masks into one RGBA texture, each channel
// the mask's coverage under a small blur. Pass 2 thresholds it at 0.5, which
// drops specks smaller than the blur (single-pixel noise would otherwise grow
// into a blob the size of the outline), fills pinholes and smooths jagged
// edges. Output rows run bottom-up (row = gl_FragCoord.y); pass 3 flips back.

precision highp float;

uniform int uNumMasks;
uniform float uSpread; // blur tap offset, px
uniform vec2 uSize; // frame width, height
uniform sampler2D uMaskTexture0;
uniform sampler2D uMaskTexture1;
uniform sampler2D uMaskTexture2;

out vec4 fragColor;

// Masks are uploaded column-major (texture s = row, t = column), values 0/1
// as bytes, sampled with LINEAR filtering so each tap averages 2x2 pixels.
float coverage(sampler2D mask, vec2 p) {
  float sum = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 q = p + vec2(float(i), float(j)) * uSpread;
      sum += texture(mask, vec2(q.y / uSize.y, q.x / uSize.x)).r;
    }
  }
  return sum * (255.0 / 9.0);
}

void main() {
  vec2 p = gl_FragCoord.xy;
  vec3 c = vec3(0.0);
  if (uNumMasks > 0) {
    c.r = coverage(uMaskTexture0, p);
  }
  if (uNumMasks > 1) {
    c.g = coverage(uMaskTexture1, p);
  }
  if (uNumMasks > 2) {
    c.b = coverage(uMaskTexture2, p);
  }
  fragColor = vec4(c, 1.0);
}
