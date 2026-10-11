#version 300 es
// Copyright (c) Meta Platforms, Inc. and affiliates.
// 
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// 
//     http://www.apache.org/licenses/LICENSE-2.0
// 
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Modified by sam-ui: a soft mask edge (uFeather), else the hard edge as before.

precision mediump float;

in vec2 vTexCoord;

uniform sampler2D uSampler;
uniform mediump vec2 uSize;
uniform lowp float uBlockSize;
uniform highp float uFeather; // box half-width, px; under half a pixel: the hard edge
uniform int uNumMasks;
uniform sampler2D uMaskTexture0;
uniform sampler2D uMaskTexture1;
uniform sampler2D uMaskTexture2;

out vec4 fragColor;

// 1 inside any mask at uv (masks are column-major: s = row, t = column)
float inside(vec2 uv) {
  vec2 st = vec2(uv.y, uv.x);
  float m = 0.0;
  if(uNumMasks > 0) {
    m = max(m, texture(uMaskTexture0, st).r);
  }
  if(uNumMasks > 1) {
    m = max(m, texture(uMaskTexture1, st).r);
  }
  if(uNumMasks > 2) {
    m = max(m, texture(uMaskTexture2, st).r);
  }
  return m > 0.0f ? 1.0f : 0.0f;
}

void main() {
  vec2 uv = vTexCoord.xy;
  float dx = uBlockSize / uSize.x;
  float dy = uBlockSize / uSize.y;

  vec2 sampleCoord = (vec2(dx * floor((uv.x / dx)), dy * floor((uv.y / dy))) +
  vec2(dx * ceil((uv.x / dx)), dy * ceil((uv.y / dy)))) / 2.0f;
  vec4 color = texture(uSampler, sampleCoord);

  float a = 0.0f;
  if(uFeather < 0.5f) {
    a = inside(uv);
  } else {
    // 5 x 5 taps over the box
    for(int j = -2; j <= 2; j++) {
      for(int i = -2; i <= 2; i++) {
        a += inside(uv + vec2(float(i), float(j)) * 0.5f * uFeather / uSize);
      }
    }
    a /= 25.0f;
  }
  fragColor = color * a;
}
