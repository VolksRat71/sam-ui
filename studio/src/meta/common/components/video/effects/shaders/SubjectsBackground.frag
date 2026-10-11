#version 300 es
// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// A background that keeps the tracked subjects as they are in the video:
// Replace background (uMode 0) draws a colour, a gradient or a picture behind
// them; Colour pop (uMode 1) turns everything else grey. uSubjects is the
// union of every tracked layer's mask (column-major: s = row, t = column).
// The feather softens only outward, so a subject's own pixels are never mixed.

precision highp float;

in vec2 vTexCoord;

uniform sampler2D uSampler; // the frame
uniform sampler2D uSubjects;
uniform sampler2D uImage;
uniform vec2 uSize; // frame width, height
uniform int uMode; // 0 replace, 1 colour pop
uniform int uFill; // replace: 0 colour, 1 gradient, 2 picture
uniform vec3 uColor;
uniform vec3 uColor2;
uniform vec2 uDirection; // gradient: along the gradient line, over its length in px (CSS angles)
uniform vec4 uImageRect; // picture: its offset and size in frame coordinates
uniform float uFeather; // box half-width, px; under half a pixel: the hard edge
uniform float uAmount; // colour pop
uniform float uContrast;

out vec4 fragColor;

float inside(vec2 uv) {
  return texture(uSubjects, vec2(uv.y, uv.x)).r > 0.0 ? 1.0 : 0.0;
}

vec3 fill(vec2 uv) {
  if (uFill == 1) {
    return mix(uColor, uColor2, clamp(dot((uv - 0.5) * uSize, uDirection) + 0.5, 0.0, 1.0));
  }
  if (uFill == 2) {
    vec2 st = (uv - uImageRect.xy) / uImageRect.zw;
    if (all(greaterThanEqual(st, vec2(0.0))) && all(lessThanEqual(st, vec2(1.0)))) {
      vec4 t = texture(uImage, st); // premultiplied (an ImageBitmap): a transparent part shows the colour
      return t.rgb + uColor * (1.0 - t.a);
    }
  }
  return uColor; // a contained picture's bars too
}

void main() {
  vec4 color = texture(uSampler, vTexCoord);
  float a = inside(vTexCoord);
  if (a < 1.0 && uFeather >= 0.5) {
    // 5 x 5 taps over the box, as the layer Pixelate's feather
    a = 0.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        a += inside(vTexCoord + vec2(float(i), float(j)) * 0.5 * uFeather / uSize);
      }
    }
    a /= 25.0;
  }
  vec3 back;
  if (uMode == 0) {
    back = fill(vTexCoord);
  } else {
    float gray = dot(color.rgb, vec3(0.3, 0.59, 0.11));
    back = clamp((mix(color.rgb, vec3(gray), uAmount) - 0.5) * uContrast + 0.5, 0.0, 1.0);
  }
  fragColor = vec4(mix(back, color.rgb, a), 1.0);
}
