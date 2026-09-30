// sam-ui (Apache-2.0). New file, not from SAM 2.
//
// A decoded video frame as the model's input: resized to size x size with
// no aspect preservation, as SAM 2 loads video frames (the backend resizes every
// frame to image_size x image_size).

export function modelBitmap(frame: VideoFrame | ImageBitmap, size: number): Promise<ImageBitmap> {
  return createImageBitmap(frame, {resizeWidth: size, resizeHeight: size, resizeQuality: 'high'});
}
