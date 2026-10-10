#version 300 es
// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Outline pass 3 of 3: the vertical half of the distance search, then the
// stroke. Outline: solid out to uWidth with a soft outer edge. Glow: a short
// solid core, then a wide falloff to 0 at uWidth. Scribble: a band about
// uWidth thick whose distance from the edge (0 to uWobble) and thickness
// follow two octaves of value noise over the frame, read from a seeded
// lattice (uNoise) the effect replaces at each boil step. Alpha is 0 inside each
// mask (distance 0; no inner anti-aliasing, which lit pinholes in noisy
// masks) and beyond the width, so the result composites as decoration over
// whatever is below. Masks are composited in order (later on top),
// premultiplied.

precision highp float;

uniform sampler2D uSpread;
uniform int uNumMasks;
uniform int uRadius;
uniform float uWidth; // px
uniform float uSoftness; // 0..1
uniform float uOpacity; // 0..1
uniform bool uGlow;
uniform bool uScribble;
uniform float uWobble; // px
uniform float uNoiseScale; // lattice uv per px
uniform sampler2D uNoise;
uniform vec3 uColor0; // 0..1
uniform vec3 uColor1;
uniform vec3 uColor2;

out vec4 fragColor;

float stroke(float d, vec2 n) {
  float e = d - 0.5; // pixel centres to the mask's edge, which lies half a pixel out
  float a;
  if (uScribble) {
    float half_ = 0.5 * uWidth * (0.5 + n.y);
    float centre = uWobble * n.x + half_;
    float feather = max(1.0, uSoftness * half_);
    a = 1.0 - smoothstep(half_ - feather, half_, abs(e - centre));
  } else if (uGlow) {
    float core = uWidth * (1.0 - uSoftness) * 0.25;
    float t = clamp((e - core) / max(uWidth - core, 1.0), 0.0, 1.0);
    a = (1.0 - t) * (1.0 - t);
  } else {
    float feather = max(1.0, uSoftness * uWidth * 0.5);
    a = 1.0 - smoothstep(uWidth - feather, uWidth, e);
  }
  return d > 0.0 ? a * uOpacity : 0.0;
}

void main() {
  int last = textureSize(uSpread, 0).y - 1;
  ivec2 p = ivec2(int(gl_FragCoord.x), last - int(gl_FragCoord.y));
  vec3 d2 = vec3(65025.0);
  for (int j = -uRadius; j <= uRadius; j++) {
    vec3 h = texelFetch(uSpread, ivec2(p.x, clamp(p.y + j, 0, last)), 0).rgb * 255.0;
    d2 = min(d2, h * h + float(j * j));
  }
  vec3 d = sqrt(d2);
  vec2 q = gl_FragCoord.xy * uNoiseScale;
  vec2 n = vec2(
    0.65 * texture(uNoise, q).r + 0.35 * texture(uNoise, q * 2.3 + 0.5).r,
    texture(uNoise, q * 0.7 + vec2(0.31, 0.77)).r
  );

  vec4 color = vec4(0.0);
  if (uNumMasks > 0) {
    float a = stroke(d.r, n);
    color = vec4(uColor0 * a, a) + color * (1.0 - a);
  }
  if (uNumMasks > 1) {
    float a = stroke(d.g, n);
    color = vec4(uColor1 * a, a) + color * (1.0 - a);
  }
  if (uNumMasks > 2) {
    float a = stroke(d.b, n);
    color = vec4(uColor2 * a, a) + color * (1.0 - a);
  }
  fragColor = color;
}
