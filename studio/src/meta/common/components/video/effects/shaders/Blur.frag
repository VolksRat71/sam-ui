#version 300 es
// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// A separable Gaussian blur in two passes, for the background Blur and the
// layer Blur. Pass 1 blurs the frame across into a texture; with masks, that
// texture's alpha is the masks' union blurred across by the feather. Pass 2
// blurs it down (colour by the radius, alpha by the feather) and writes it
// premultiplied: the whole frame for the background (no masks, alpha 1), the
// inside of the masks with a soft edge for a layer.

precision highp float;

in vec2 vTexCoord;

uniform sampler2D uSampler; // pass 1: the frame
uniform sampler2D uPass1; // pass 2: pass 1's output, read by gl_FragCoord (same size)
uniform bool uVertical; // pass 2
uniform vec2 uSize; // frame width, height
uniform float uSigma; // px; 0 = no blur
uniform int uTaps; // px each side
uniform float uFeatherSigma;
uniform int uFeatherTaps;
uniform int uNumMasks; // 0: the whole frame
uniform sampler2D uMaskTexture0;
uniform sampler2D uMaskTexture1;
uniform sampler2D uMaskTexture2;

out vec4 fragColor;

float weight(int i, float sigma) {
  return sigma > 0.0 ? exp(-0.5 * float(i * i) / (sigma * sigma)) : float(i == 0);
}

// 1 inside any mask at uv. Masks are column-major (s = row, t = column), bytes 0/1.
float inside(vec2 uv) {
  vec2 st = vec2(uv.y, uv.x);
  float m = texture(uMaskTexture0, st).r;
  if (uNumMasks > 1) {
    m = max(m, texture(uMaskTexture1, st).r);
  }
  if (uNumMasks > 2) {
    m = max(m, texture(uMaskTexture2, st).r);
  }
  return step(0.5 / 255.0, m);
}

void main() {
  vec3 rgb = vec3(0.0);
  float sum = 0.0;
  float a = 1.0;
  if (!uVertical) {
    for (int i = -uTaps; i <= uTaps; i++) {
      float w = weight(i, uSigma);
      rgb += w * texture(uSampler, vTexCoord + vec2(float(i) / uSize.x, 0.0)).rgb;
      sum += w;
    }
    if (uNumMasks > 0) {
      float asum = 0.0;
      a = 0.0;
      for (int i = -uFeatherTaps; i <= uFeatherTaps; i++) {
        float w = weight(i, uFeatherSigma);
        a += w * inside(vTexCoord + vec2(float(i) / uSize.x, 0.0));
        asum += w;
      }
      a /= asum;
    }
    fragColor = vec4(rgb / sum, a);
    return;
  }
  ivec2 p = ivec2(gl_FragCoord.xy);
  int last = textureSize(uPass1, 0).y - 1;
  for (int j = -uTaps; j <= uTaps; j++) {
    float w = weight(j, uSigma);
    rgb += w * texelFetch(uPass1, ivec2(p.x, clamp(p.y + j, 0, last)), 0).rgb;
    sum += w;
  }
  float asum = 0.0;
  a = 0.0;
  for (int j = -uFeatherTaps; j <= uFeatherTaps; j++) {
    float w = weight(j, uFeatherSigma);
    a += w * texelFetch(uPass1, ivec2(p.x, clamp(p.y + j, 0, last)), 0).a;
    asum += w;
  }
  a /= asum;
  fragColor = vec4(rgb / sum * a, a);
}
