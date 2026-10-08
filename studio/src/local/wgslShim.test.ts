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

  it('inlines uses before the declaration and constructor calls, and is idempotent', () => {
    const code = 'fn f() { var i = output_indices_t(0u, 1u, 2u, 3u, 4u); }\nalias output_indices_t = array<u32, 5>;';
    const once = inlineArrayAliases(code);
    expect(once).toBe('fn f() { var i = array<u32, 5>(0u, 1u, 2u, 3u, 4u); }\n');
    expect(inlineArrayAliases(once)).toBe(once);
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
    expect(rewriteF16Bitcasts('mybitcast<vec2<f16>>(x)')).toBe('mybitcast<vec2<f16>>(x)');
  });

  it('rewrites the Clip form, spaced-out forms and two on one line, and is idempotent', () => {
    const clip = 'vec4<f16>(bitcast<vec2<f16>>(uniforms.attr)[0])';
    expect(rewriteF16Bitcasts(clip)).toBe('vec4<f16>(vec2<f16>(unpack2x16float(bitcast<u32>(uniforms.attr)))[0])');
    expect(rewriteF16Bitcasts('bitcast< vec2< f16 > >\n( x )')).toBe('vec2<f16>(unpack2x16float(bitcast<u32>( x )))');
    expect(rewriteF16Bitcasts('let a = bitcast<vec2<f16>>(u.a)[0]; let b = bitcast<vec2<f16>>(u.b)[1];')).toBe(
      'let a = vec2<f16>(unpack2x16float(bitcast<u32>(u.a)))[0]; let b = vec2<f16>(unpack2x16float(bitcast<u32>(u.b)))[1];',
    );
    const once = rewriteF16Bitcasts(clip);
    expect(rewriteF16Bitcasts(once)).toBe(once);
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
