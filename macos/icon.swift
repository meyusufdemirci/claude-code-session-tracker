// Draws the app icon into App/Assets.xcassets, from the same mark as the dashboard's
// favicon in src/web/index.html: a dark plate, a faint ring and a dot.
//
//   swift icon.swift
//
// The PNGs are checked in; run this again only when the mark changes.
import AppKit

let plate = CGColor(red: 0x14 / 255, green: 0x14 / 255, blue: 0x13 / 255, alpha: 1)
let accent = CGColor(red: 0xd9 / 255, green: 0x77 / 255, blue: 0x57 / 255, alpha: 1)
let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("App/Assets.xcassets/AppIcon.appiconset")

func draw(_ pixels: Int) throws {
  let context = CGContext(data: nil, width: pixels, height: pixels, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  // macOS icons sit on a 1024 grid with the plate inset to 824; the favicon's is 32 wide.
  context.scaleBy(x: CGFloat(pixels) / 1024, y: CGFloat(pixels) / 1024)
  context.translateBy(x: 100, y: 100)
  context.scaleBy(x: 824.0 / 32, y: 824.0 / 32)

  context.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: 32, height: 32), cornerWidth: 7, cornerHeight: 7, transform: nil))
  context.setFillColor(plate)
  context.fillPath()

  context.setStrokeColor(accent.copy(alpha: 0.45)!)
  context.setLineWidth(2)
  context.strokeEllipse(in: CGRect(x: 7, y: 7, width: 18, height: 18))

  context.setFillColor(accent)
  context.fillEllipse(in: CGRect(x: 12, y: 12, width: 8, height: 8))

  let png = NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!
  try png.write(to: folder.appendingPathComponent("icon-\(pixels).png"))
}

var images: [[String: String]] = []
for size in [16, 32, 128, 256, 512] {
  for scale in [1, 2] {
    images.append(["idiom": "mac", "size": "\(size)x\(size)", "scale": "\(scale)x", "filename": "icon-\(size * scale).png"])
  }
}
for pixels in Set(images.map { Int($0["filename"]!.dropFirst(5).dropLast(4))! }) { try draw(pixels) }

let contents: [String: Any] = ["images": images, "info": ["author": "xcode", "version": 1]]
try JSONSerialization.data(withJSONObject: contents, options: [.prettyPrinted, .sortedKeys]).write(to: folder.appendingPathComponent("Contents.json"))
