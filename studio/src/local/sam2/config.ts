// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// The two SAM 2.1 tiny video exports the browser engine runs. Both are
// Apache-2.0, fetched from Hugging Face at run time and never committed.

export type Quality = 512 | 1024;

export const MODEL_FILES = [
  'onnx/vision_encoder.onnx',
  'onnx/mask_decoder.onnx',
  'onnx/memory_encoder.onnx',
  'onnx/memory_attention.onnx',
  'onnx/pointer_tpos.onnx',
] as const;
export type ModelFile = (typeof MODEL_FILES)[number];

export type Variant = {
  quality: Quality;
  repo: string;
  label: string;
  /** Bytes of the five graphs plus constants.json, for the first-run notice. */
  bytes: number;
};

export const VARIANTS: Record<Quality, Variant> = {
  512: {
    quality: 512,
    repo: 'diffusionstudio/sam2.1-tiny-video-onnx-fp16',
    label: '512 px, fp16',
    bytes: 58_385_353 + 8_898_805 + 2_807_753 + 13_029_470 + 34_228 + 9_781,
  },
  1024: {
    quality: 1024,
    repo: 'square-zero-labs/sam2.1-tiny-video-onnx',
    label: '1024 px, fp32',
    bytes: 134_335_567 + 17_794_355 + 5_616_496 + 32_259_165 + 67_289 + 9_922,
  },
};

export function parseQuality(raw: unknown): Quality {
  return Number(raw) === 1024 ? 1024 : 512;
}

/** What the tracker needs from constants.json (the two exports spell it differently). */
export type Sam2Constants = {
  imageSize: number;
  /** Feature map side (image size / 16). */
  featSize: number;
  numMaskmem: number;
  maxPointers: number;
  memDim: number;
  mean: [number, number, number];
  std: [number, number, number];
  /** num_maskmem x mem_dim temporal PE; the seed memory uses the last row. */
  tpos: number[][];
};

export function parseConstants(raw: Record<string, unknown>): Sam2Constants {
  const imageSize = Number(raw.image_size);
  if (!(imageSize > 0)) {
    throw new Error('constants.json: no image_size');
  }
  const tpos = raw.memory_temporal_positional_encoding as number[][] | undefined;
  if (!Array.isArray(tpos) || tpos.length === 0) {
    throw new Error('constants.json: no memory_temporal_positional_encoding');
  }
  const numMaskmem = Number(raw.num_maskmem ?? raw.memory_frames ?? tpos.length);
  const trio = (v: unknown, fallback: [number, number, number]) =>
    Array.isArray(v) && v.length === 3 ? (v.map(Number) as [number, number, number]) : fallback;
  return {
    imageSize,
    featSize: Number(raw.feat_size ?? imageSize / 16),
    numMaskmem,
    maxPointers: Number(raw.max_object_pointers ?? 16),
    memDim: Number(raw.mem_dim ?? tpos[0].length),
    mean: trio(raw.image_mean, [0.485, 0.456, 0.406]),
    std: trio(raw.image_std, [0.229, 0.224, 0.225]),
    tpos,
  };
}
