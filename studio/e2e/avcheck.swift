// sam-ui (Apache-2.0). New file, not from SAM 2.
// Opens an MP4 with AVFoundation (QuickTime's engine) and decodes every frame.
//   swift studio/e2e/avcheck.swift studio/e2e/out/export.mp4
import AVFoundation

let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
let done = DispatchSemaphore(value: 0)
Task {
  do {
    let playable = try await asset.load(.isPlayable)
    let duration = try await asset.load(.duration)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(
      track: tracks[0],
      outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    reader.startReading()
    var frames = 0
    while output.copyNextSampleBuffer() != nil { frames += 1 }
    let ok = playable && reader.status == .completed
    print("AVFoundation: playable=\(playable) duration=\(CMTimeGetSeconds(duration))s decodedFrames=\(frames) ok=\(ok)")
    exit(ok ? 0 : 1)
  } catch {
    print("AVFoundation error: \(error)")
    exit(1)
  }
}
done.wait()
