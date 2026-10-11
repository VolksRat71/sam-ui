#version 300 es
// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Outline pass 2 of 3: per mask (r, g, b), the horizontal distance in pixels
// to the nearest mask pixel within uRadius, stored as d / 255 (exact for
// whole pixels; 255 = none in reach). Pass 3 runs the same search vertically
// over these, which together give the exact Euclidean distance within the
// radius at 2 x (2 x radius + 1) fetches a pixel.

precision highp float;

uniform sampler2D uCover;
uniform int uRadius;

out vec4 fragColor;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int last = textureSize(uCover, 0).x - 1;
  vec3 d = vec3(255.0);
  for (int i = -uRadius; i <= uRadius; i++) {
    vec3 inside = step(0.5, texelFetch(uCover, ivec2(clamp(p.x + i, 0, last), p.y), 0).rgb);
    d = min(d, mix(vec3(255.0), vec3(abs(float(i))), inside));
  }
  fragColor = vec4(d / 255.0, 1.0);
}
