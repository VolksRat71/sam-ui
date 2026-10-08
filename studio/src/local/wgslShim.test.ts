import {describe, expect, it} from 'vitest';
import {inlineArrayAliases, installWgslShim, rewriteF16Bitcasts} from './wgslShim';

describe('inlineArrayAliases', () => {
  it('writes array types in place of their aliases and keeps other aliases', () => {
    const code = [
      'alias input_0_indices_t = array<u32, 5>;',
      'alias output_indices_t = array<u32, 5>;',
      'alias output_value_t = f16;',
      'fn set_output_by_indices(indices: output_indices_t) {}',
      'fn f(i: input_0_indices_t, j: input_0_indices_tx) { set_output_by_indices(i); }',
    ].join('\n');
    expect(inlineArrayAliases(code)).toBe(
      [
        '',
        '',
        'alias output_value_t = f16;',
        'fn set_output_by_indices(indices: array<u32, 5>) {}',
        'fn f(i: array<u32, 5>, j: input_0_indices_tx) { set_output_by_indices(i); }',
      ].join('\n'),
    );
    expect(inlineArrayAliases('alias a = vec4<u32>;')).toBe('alias a = vec4<u32>;');
  });
});

describe('rewriteF16Bitcasts', () => {
  it('rewrites the Pad kernel and GetElementAt forms', () => {
    expect(rewriteF16Bitcasts('let c = bitcast<vec2<f16>>(uniforms.constant_value)[0];')).toBe(
      'let c = vec2<f16>(unpack2x16float(bitcast<u32>(uniforms.constant_value)))[0];',
    );
    expect(rewriteF16Bitcasts('bitcast<vec2<f16>>(uniforms.s[(i) / 8][((i) % 8) / 2])[((i) % 8) % 2]')).toBe(
      'vec2<f16>(unpack2x16float(bitcast<u32>(uniforms.s[(i) / 8][((i) % 8) / 2])))[((i) % 8) % 2]',
    );
  });

  it('handles nesting and leaves other code alone', () => {
    expect(rewriteF16Bitcasts('bitcast<vec2<f16>>(f(bitcast<vec2<f16>>(x).x))')).toBe(
      'vec2<f16>(unpack2x16float(bitcast<u32>(f(vec2<f16>(unpack2x16float(bitcast<u32>(x))).x))))',
    );
    const plain = 'let a = bitcast<f32>(u); let b = bitcast<vec4<f16>>(v);';
    expect(rewriteF16Bitcasts(plain)).toBe(plain);
    expect(rewriteF16Bitcasts('bitcast<vec2<f16>>(x')).toBe('bitcast<vec2<f16>>(x');
  });

  it('patches createShaderModule', () => {
    const seen: string[] = [];
    class GPUDevice {
      createShaderModule(desc: {code: string}) {
        seen.push(desc.code);
        return desc;
      }
    }
    installWgslShim({GPUDevice});
    new GPUDevice().createShaderModule({code: 'bitcast<vec2<f16>>(u)'});
    expect(seen).toEqual(['vec2<f16>(unpack2x16float(bitcast<u32>(u)))']);
  });
});
