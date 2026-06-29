// apple-vision-ocr.swift — local, free, on-device OCR via Apple Vision (VNRecognizeTextRequest).
// Resolves the "SAM3 can't read text" blocker: detects + reads text regions with bounding boxes.
//
// Usage:  swift apple-vision-ocr.swift <input.png> [output.json]
//   or compiled:  swiftc -O apple-vision-ocr.swift -o apple-vision-ocr && ./apple-vision-ocr <in> <out>
//
// Output JSON:
//   { "imageWidth": W, "imageHeight": H,
//     "lines": [ { "text": "...", "confidence": 0.97,
//                  "bbox": { "x": px, "y": px, "width": px, "height": px } } ] }
// bbox is in TOP-LEFT pixel coordinates (Vision's normalized bottom-left origin is converted).

import Foundation
import Vision
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write(("apple-vision-ocr: " + msg + "\n").data(using: .utf8)!)
    exit(2)
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("usage: apple-vision-ocr <input-image> [output.json]") }
let inputPath = args[1]
let outputPath = args.count >= 3 ? args[2] : nil

guard let dataProvider = CGDataProvider(filename: inputPath) else { fail("cannot open \(inputPath)") }
let url = URL(fileURLWithPath: inputPath)
guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
    _ = dataProvider
    fail("cannot decode image \(inputPath)")
}

let W = cgImage.width
let H = cgImage.height

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["ko-KR", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("OCR failed: \(error.localizedDescription)")
}

struct BBox: Encodable { let x: Int; let y: Int; let width: Int; let height: Int }
struct Line: Encodable { let text: String; let confidence: Float; let bbox: BBox }
struct Result: Encodable { let imageWidth: Int; let imageHeight: Int; let lines: [Line] }

var lines: [Line] = []
if let observations = request.results {
    for obs in observations {
        guard let top = obs.topCandidates(1).first else { continue }
        // Vision boundingBox: normalized [0,1], origin BOTTOM-LEFT.
        let bb = obs.boundingBox
        let px = Int((bb.minX * CGFloat(W)).rounded())
        let pw = Int((bb.width * CGFloat(W)).rounded())
        let ph = Int((bb.height * CGFloat(H)).rounded())
        // convert bottom-left origin -> top-left origin
        let pyTop = Int(((1.0 - bb.maxY) * CGFloat(H)).rounded())
        lines.append(Line(text: top.string,
                          confidence: top.confidence,
                          bbox: BBox(x: px, y: pyTop, width: pw, height: ph)))
    }
}

let result = Result(imageWidth: W, imageHeight: H, lines: lines)
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes]
let json = try encoder.encode(result)

if let outputPath = outputPath {
    try json.write(to: URL(fileURLWithPath: outputPath))
    FileHandle.standardError.write("apple-vision-ocr: wrote \(lines.count) lines -> \(outputPath)\n".data(using: .utf8)!)
} else {
    FileHandle.standardOutput.write(json)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
