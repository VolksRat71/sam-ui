// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// Rewrites ONNX Runtime Web's WebGPU shaders around two gaps in Firefox's WGSL
// compiler (naga), each of which stops the browser engine in Firefox:
//   - bitcasts that change the vector size, such as bitcast<vec2<f16>>(u32),
//     do not compile (gfx-rs/wgpu#8896). ORT unpacks f16 uniforms that way, so
//     the fp16 models' Pad shader fails and the first mask never comes.
//     unpack2x16float does the same unpacking, and the f16 -> f32 -> f16
//     round trip is exact.
//   - on Metal, two aliases of the same array type become two distinct types,
//     so passing one where the other is expected fails when the pipeline is
//     made. ORT's indices aliases for rank > 4 tensors (input_0_indices_t =
//     array<u32, 5> and so on) hit this, and tracking stops. Writing the array
//     type in place of each alias gives naga one type.
// Both rewrites leave the shader's meaning unchanged, so every browser gets them.
// ponytail: remove once Firefox's naga fixes both (check by deleting this and
// running the juggle sample in Firefox).

const BITCAST = /bitcast\s*<\s*vec2\s*<\s*f16\s*>\s*>\s*\(/g;

/** `code` with every bitcast<vec2<f16>>(x) written as vec2<f16>(unpack2x16float(bitcast<u32>(x))). */
export function rewriteF16Bitcasts(code: string): string {
  const re = new RegExp(BITCAST); // own lastIndex: this recurses
  let out = '';
  let at = 0;
  for (let m = re.exec(code); m != null; m = re.exec(code)) {
    // find the bitcast's closing parenthesis
    let depth = 1;
    let end = re.lastIndex;
    for (; end < code.length && depth > 0; end++) {
      depth += code[end] === '(' ? 1 : code[end] === ')' ? -1 : 0;
    }
    if (depth !== 0) {
      return code; // unbalanced: leave it to the compiler to report
    }
    const arg = rewriteF16Bitcasts(code.slice(re.lastIndex, end - 1));
    out += `${code.slice(at, m.index)}vec2<f16>(unpack2x16float(bitcast<u32>(${arg})))`;
    at = re.lastIndex = end;
  }
  return out + code.slice(at);
}

/** `code` with each `alias name = array<...>;` removed and `name` replaced by the array type. */
export function inlineArrayAliases(code: string): string {
  const aliases = new Map<string, string>();
  const stripped = code.replace(/\balias\s+(\w+)\s*=\s*(array\s*<[^;]*>)\s*;/g, (_, name: string, type: string) => {
    aliases.set(name, type);
    return '';
  });
  if (aliases.size === 0) {
    return code;
  }
  return stripped.replace(new RegExp(`\\b(${[...aliases.keys()].join('|')})\\b`, 'g'), name => aliases.get(name)!);
}

type DeviceProto = {createShaderModule(desc: {code: string}): unknown};

/** Rewrites every WGSL module this worker's WebGPU devices compile. Call before ONNX Runtime makes its device. */
export function installWgslShim(scope: {GPUDevice?: {prototype: DeviceProto}} = globalThis as never): void {
  const proto = scope.GPUDevice?.prototype;
  if (proto == null) {
    return;
  }
  const create = proto.createShaderModule;
  proto.createShaderModule = function (desc) {
    return create.call(this, {...desc, code: inlineArrayAliases(rewriteF16Bitcasts(desc.code))});
  };
}
