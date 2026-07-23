import Foundation
import AVFoundation
import CoreImage
import CoreGraphics
import AppKit

let args = CommandLine.arguments
guard args.count == 5 else {
    fputs("usage: swift make_concept_video.swift image1 image2 image3 output.mp4\n", stderr)
    exit(2)
}

let imageURLs = args[1...3].map { URL(fileURLWithPath: $0) }
let outputURL = URL(fileURLWithPath: args[4])
let width = 1920
let height = 1080
let fps: Int32 = 30
let secondsPerScene = 8.0
let transitionSeconds = 1.4
let totalSeconds = secondsPerScene * 3.0
let totalFrames = Int(totalSeconds * Double(fps))
let ciContext = CIContext(options: [.useSoftwareRenderer: false])
let colorSpace = CGColorSpaceCreateDeviceRGB()

let images: [CIImage] = try imageURLs.map { url in
    guard let image = CIImage(contentsOf: url) else {
        throw NSError(domain: "ConceptVideo", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not load \(url.path)"])
    }
    return image
}

try? FileManager.default.removeItem(at: outputURL)
let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
let settings: [String: Any] = [
    AVVideoCodecKey: AVVideoCodecType.h264,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 8_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
    ]
]
let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
input.expectsMediaDataInRealTime = false
let attributes: [String: Any] = [
    kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
    kCVPixelBufferWidthKey as String: width,
    kCVPixelBufferHeightKey as String: height,
    kCVPixelBufferIOSurfacePropertiesKey as String: [:]
]
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: attributes)
guard writer.canAdd(input) else { throw NSError(domain: "ConceptVideo", code: 2) }
writer.add(input)
guard writer.startWriting() else { throw writer.error ?? NSError(domain: "ConceptVideo", code: 3) }
writer.startSession(atSourceTime: .zero)

func smooth(_ x: Double) -> Double {
    let t = min(1, max(0, x))
    return t * t * (3 - 2 * t)
}

func framed(_ image: CIImage, progress: Double, scene: Int) -> CIImage {
    let baseScale = max(CGFloat(width) / image.extent.width, CGFloat(height) / image.extent.height)
    let direction = scene == 1 ? -1.0 : 1.0
    let zoom = 1.0 + 0.075 * progress
    let scale = baseScale * zoom
    var transformed = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    let overflowX = max(0, transformed.extent.width - CGFloat(width))
    let overflowY = max(0, transformed.extent.height - CGFloat(height))
    let driftX = CGFloat(direction * (progress - 0.5)) * min(55, overflowX * 0.35)
    let x = transformed.extent.midX - CGFloat(width) / 2 + driftX
    let y = transformed.extent.midY - CGFloat(height) / 2 + CGFloat(progress - 0.5) * min(20, overflowY * 0.2)
    transformed = transformed.cropped(to: CGRect(x: x, y: y, width: CGFloat(width), height: CGFloat(height)))
    return transformed.transformed(by: CGAffineTransform(translationX: -x, y: -y))
}

func titleOverlay(_ title: String, subtitle: String, opacity: CGFloat) -> CIImage? {
    guard opacity > 0.001 else { return nil }
    let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
    guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8,
                              bytesPerRow: width * 4, space: colorSpace, bitmapInfo: bitmapInfo) else { return nil }
    ctx.clear(CGRect(x: 0, y: 0, width: width, height: height))
    let ns = NSGraphicsContext(cgContext: ctx, flipped: false)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ns
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.8)
    shadow.shadowBlurRadius = 18
    shadow.shadowOffset = NSSize(width: 0, height: -2)
    let titleAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 64, weight: .semibold),
        .foregroundColor: NSColor.white.withAlphaComponent(opacity),
        .kern: 7.0,
        .paragraphStyle: paragraph,
        .shadow: shadow
    ]
    let subAttrs: [NSAttributedString.Key: Any] = [
        .font: NSFont.systemFont(ofSize: 27, weight: .medium),
        .foregroundColor: NSColor(calibratedRed: 0.78, green: 0.92, blue: 0.26, alpha: opacity),
        .kern: 3.0,
        .paragraphStyle: paragraph,
        .shadow: shadow
    ]
    (title as NSString).draw(in: NSRect(x: 120, y: 164, width: width - 240, height: 90), withAttributes: titleAttrs)
    (subtitle as NSString).draw(in: NSRect(x: 120, y: 121, width: width - 240, height: 48), withAttributes: subAttrs)
    NSGraphicsContext.restoreGraphicsState()
    guard let cg = ctx.makeImage() else { return nil }
    return CIImage(cgImage: cg)
}

let titles = [
    ("BUILDING ALONE", "ONE PERSON. ONE SPARK."),
    ("FIND THE BONFIRE", "FORK. BUILD. CONVERGE."),
    ("BUILD THE CITY", "TOGETHER, THE IDEA BECOMES REAL.")
]

for frame in 0..<totalFrames {
    while !input.isReadyForMoreMediaData { Thread.sleep(forTimeInterval: 0.002) }
    let time = Double(frame) / Double(fps)
    let scene = min(2, Int(time / secondsPerScene))
    let local = (time - Double(scene) * secondsPerScene) / secondsPerScene
    var composition = framed(images[scene], progress: local, scene: scene)

    let remaining = secondsPerScene - (time - Double(scene) * secondsPerScene)
    if scene < 2 && remaining < transitionSeconds {
        let blend = smooth(1 - remaining / transitionSeconds)
        let next = framed(images[scene + 1], progress: blend * 0.12, scene: scene + 1)
        composition = next.applyingFilter("CIDissolveTransition", parameters: [
            kCIInputTargetImageKey: composition,
            kCIInputTimeKey: blend
        ]).cropped(to: CGRect(x: 0, y: 0, width: width, height: height))
    }

    let fadeIn = smooth(min(1, local / 0.12))
    let fadeOut = smooth(min(1, (1 - local) / 0.18))
    let textOpacity = CGFloat(min(fadeIn, fadeOut))
    if let overlay = titleOverlay(titles[scene].0, subtitle: titles[scene].1, opacity: textOpacity) {
        composition = overlay.composited(over: composition)
    }

    guard let pool = adaptor.pixelBufferPool else { throw NSError(domain: "ConceptVideo", code: 4) }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
    guard let pixelBuffer = buffer else { throw NSError(domain: "ConceptVideo", code: 5) }
    ciContext.render(composition, to: pixelBuffer, bounds: CGRect(x: 0, y: 0, width: width, height: height), colorSpace: colorSpace)
    let presentation = CMTime(value: CMTimeValue(frame), timescale: fps)
    guard adaptor.append(pixelBuffer, withPresentationTime: presentation) else {
        throw writer.error ?? NSError(domain: "ConceptVideo", code: 6)
    }
}

input.markAsFinished()
await writer.finishWriting()
if writer.status != .completed {
    throw writer.error ?? NSError(domain: "ConceptVideo", code: 7)
}
print(outputURL.path)
