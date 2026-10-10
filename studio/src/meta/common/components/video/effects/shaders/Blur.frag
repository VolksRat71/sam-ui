#version 300 es
// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// A separable Gaussian blur in two passes, for the background Blur and the
// layer Blur. With masks, each mask is blurred from its own pixels only
// (normalised over it), so neither the background nor a neighbouring object
// bleeds into a subject's edge. Pass 1 (across) writes, per mask i, the
// masked average colour and the share of the kernel inside the mask (out i),
// and every mask blurred by the feather (out 3: r, g, b). Pass 2 (down)
// weights pass 1's colours by those shares, blurs the feathers, and
// composites the masks in order (later on top), premultiplied. With no masks
// (the background) every pixel counts as one mask over the whole frame.

precision highp float;

in vec2 vTexCoord;

uniform sampler2D uSampler; // the frame
uniform sampler2D uPass1_0; // pass 2: pass 1's out 0-2 and 3, read by gl_FragCoord (same size)
uniform sampler2D uPass1_1;
uniform sampler2D uPass1_2;
uniform sampler2D uFeather;
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

layout(location = 0) out vec4 out0;
layout(location = 1) out vec4 out1;
layout(location = 2) out vec4 out2;
layout(location = 3) out vec4 out3;

float weight(int i, float sigma) {
  return sigma > 0.0 ? exp(-0.5 * float(i * i) / (sigma * sigma)) : float(i == 0);
}

// Each mask at uv, 1 inside (1, 0, 0 with no masks). Masks are column-major (s = row, t = column), bytes 0/1.
vec3 inside(vec2 uv) {
  if (uNumMasks == 0) {
    return vec3(1.0, 0.0, 0.0);
  }
  vec2 st = vec2(uv.y, uv.x);
  vec3 m = vec3(texture(uMaskTexture0, st).r, 0.0, 0.0);
  if (uNumMasks > 1) {
    m.g = texture(uMaskTexture1, st).r;
  }
  if (uNumMasks > 2) {
    m.b = texture(uMaskTexture2, st).r;
  }
  return step(0.5 / 255.0, m);
}

// Pass 2 for one mask: its colour blurred down over pass 1's shares; w = how much of the kernel was inside it.
vec4 down(sampler2D pass1, ivec2 p, int last) {
  vec3 rgb = vec3(0.0);
  float w = 0.0;
  for (int j = -uTaps; j <= uTaps; j++) {
    vec4 h = texelFetch(pass1, ivec2(p.x, clamp(p.y + j, 0, last)), 0);
    float m = weight(j, uSigma) * h.a;
    rgb += m * h.rgb;
    w += m;
  }
  // a feathered edge beyond the blur's reach of the mask: the frame as it is
  return vec4(w > 1e-4 ? rgb / w : texture(uSampler, vTexCoord).rgb, w);
}

void main() {
  if (!uVertical) {
    vec3 rgb0 = vec3(0.0), rgb1 = vec3(0.0), rgb2 = vec3(0.0);
    vec3 in_ = vec3(0.0);
    float sum = 0.0;
    for (int i = -uTaps; i <= uTaps; i++) {
      vec2 uv = vTexCoord + vec2(float(i) / uSize.x, 0.0);
      float w = weight(i, uSigma);
      vec3 m = w * inside(uv);
      vec3 c = texture(uSampler, uv).rgb;
      rgb0 += m.r * c;
      rgb1 += m.g * c;
      rgb2 += m.b * c;
      in_ += m;
      sum += w;
    }
    vec3 a = vec3(0.0);
    float asum = 0.0;
    for (int i = -uFeatherTaps; i <= uFeatherTaps; i++) {
      float w = weight(i, uFeatherSigma);
      a += w * inside(vTexCoord + vec2(float(i) / uSize.x, 0.0));
      asum += w;
    }
    // average colours (full 8-bit precision however little of the row is inside) and their weights
    out0 = vec4(in_.r > 0.0 ? rgb0 / in_.r : vec3(0.0), in_.r / sum);
    out1 = vec4(in_.g > 0.0 ? rgb1 / in_.g : vec3(0.0), in_.g / sum);
    out2 = vec4(in_.b > 0.0 ? rgb2 / in_.b : vec3(0.0), in_.b / sum);
    out3 = vec4(a / asum, 1.0);
    return;
  }
  ivec2 p = ivec2(gl_FragCoord.xy);
  int last = textureSize(uFeather, 0).y - 1;
  vec3 a = vec3(0.0);
  float asum = 0.0;
  for (int j = -uFeatherTaps; j <= uFeatherTaps; j++) {
    float w = weight(j, uFeatherSigma);
    a += w * texelFetch(uFeather, ivec2(p.x, clamp(p.y + j, 0, last)), 0).rgb;
    asum += w;
  }
  a /= asum;
  vec4 color = vec4(down(uPass1_0, p, last).rgb * a.r, a.r);
  if (uNumMasks > 1) {
    color = vec4(down(uPass1_1, p, last).rgb * a.g, a.g) + color * (1.0 - a.g);
  }
  if (uNumMasks > 2) {
    color = vec4(down(uPass1_2, p, last).rgb * a.b, a.b) + color * (1.0 - a.b);
  }
  out0 = color;
}
