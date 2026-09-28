// Renders the iOS app icon from the same geometry as the Android launcher
// (res/drawable/ic_launcher_background.xml and ic_launcher_foreground.xml):
// the red tile, its faint diagonal stripes and the white shuttle mark.
// Run from apps/mobile/ios:  swift scripts/render-app-icon.swift
// Full bleed, square and opaque: iOS applies its own mask.

import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let size = 1024
let viewport: CGFloat = 108
let scale = CGFloat(size) / viewport

func color(_ argb: UInt32) -> CGColor {
    CGColor(
        srgbRed: CGFloat((argb >> 16) & 0xFF) / 255,
        green: CGFloat((argb >> 8) & 0xFF) / 255,
        blue: CGFloat(argb & 0xFF) / 255,
        alpha: CGFloat((argb >> 24) & 0xFF) / 255,
    )
}

/// The path commands the drawables use: M, L, V, c, a and z (upper case absolute,
/// lower case relative). Nothing else is supported, so a new command fails loudly.
func parsePath(_ d: String) -> CGPath {
    let path = CGMutablePath()
    var tokens: [String] = []
    var current = ""
    func flush() {
        if !current.isEmpty { tokens.append(current) }
        current = ""
    }
    for ch in d {
        if ch.isLetter {
            flush()
            tokens.append(String(ch))
        } else if ch == "," || ch == " " {
            flush()
        } else if ch == "-" && !current.isEmpty && !current.hasSuffix("e") {
            flush()
            current = "-"
        } else {
            current.append(ch)
        }
    }
    flush()

    var i = 0
    var point = CGPoint.zero
    var start = CGPoint.zero
    var command = ""
    func number() -> CGFloat {
        defer { i += 1 }
        guard let v = Double(tokens[i]) else { fatalError("Not a number: \(tokens[i])") }
        return CGFloat(v)
    }
    while i < tokens.count {
        if tokens[i].first!.isLetter {
            command = tokens[i]
            i += 1
        }
        switch command {
        case "M":
            point = CGPoint(x: number(), y: number())
            start = point
            path.move(to: point)
            command = "L"
        case "L":
            point = CGPoint(x: number(), y: number())
            path.addLine(to: point)
        case "V":
            point = CGPoint(x: point.x, y: number())
            path.addLine(to: point)
        case "c":
            let c1 = CGPoint(x: point.x + number(), y: point.y + number())
            let c2 = CGPoint(x: point.x + number(), y: point.y + number())
            let end = CGPoint(x: point.x + number(), y: point.y + number())
            path.addCurve(to: end, control1: c1, control2: c2)
            point = end
        case "a":
            let rx = number(), ry = number()
            _ = number()
            let large = number() != 0, sweep = number() != 0
            let end = CGPoint(x: point.x + number(), y: point.y + number())
            addArc(path, from: point, to: end, radius: min(rx, ry), large: large, sweep: sweep)
            point = end
        case "z", "Z":
            path.closeSubpath()
            point = start
        default:
            fatalError("Unsupported path command \(command)")
        }
    }
    return path
}

/// A circular SVG arc (rx == ry, no rotation), by its endpoint parameterisation.
func addArc(_ path: CGMutablePath, from p0: CGPoint, to p1: CGPoint, radius r0: CGFloat, large: Bool, sweep: Bool) {
    let mid = CGPoint(x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2)
    let dx = p1.x - p0.x, dy = p1.y - p0.y
    let chord = (dx * dx + dy * dy).squareRoot()
    let r = max(r0, chord / 2)
    let h = (max(0, r * r - chord * chord / 4)).squareRoot()
    let sign: CGFloat = large == sweep ? -1 : 1
    let center = CGPoint(x: mid.x + sign * h * -dy / chord, y: mid.y + sign * h * dx / chord)
    let a0 = atan2(p0.y - center.y, p0.x - center.x)
    let a1 = atan2(p1.y - center.y, p1.x - center.x)
    // SVG's sweep flag 1 is increasing angle in y-down space, which CoreGraphics
    // (y-down here, after the flip) draws as clockwise == false.
    path.addArc(center: center, radius: r, startAngle: a0, endAngle: a1, clockwise: !sweep)
}

let space = CGColorSpace(name: CGColorSpace.sRGB)!
guard let ctx = CGContext(
    data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue,
) else { fatalError("No context") }

// Android's y axis points down.
ctx.translateBy(x: 0, y: CGFloat(size))
ctx.scaleBy(x: scale, y: -scale)

ctx.setFillColor(color(0xFFCC0000))
ctx.fill(CGRect(x: 0, y: 0, width: viewport, height: viewport))

ctx.setStrokeColor(color(0x14FFFFFF))
ctx.setLineWidth(2.1)
ctx.addPath(parsePath("M13.5,0L0,13.5 M40.5,0L0,40.5 M67.5,0L0,67.5 M94.5,0L0,94.5 M121.5,0L0,121.5 M148.5,0L0,148.5 M175.5,0L0,175.5 M202.5,0L0,202.5"))
ctx.strokePath()

ctx.translateBy(x: 32, y: 32)
ctx.scaleBy(x: 1.8333, y: 1.8333)
ctx.setFillColor(color(0xFFFFFFFF))
ctx.addPath(parsePath("M9.8,17.6a2.2,2.2 0,1 1,4.4,0a2.2,2.2 0,1 1,-4.4,0z"))
ctx.fillPath()
ctx.setStrokeColor(color(0xFFFFFFFF))
ctx.setLineWidth(1.7)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.addPath(parsePath("M10.2,15.9L6,5.4 M12,15.9V4.2 M13.8,15.9L18,5.4 M7.4,9.1c3,-1.5 6.2,-1.5 9.2,0"))
ctx.strokePath()

guard let image = ctx.makeImage() else { fatalError("No image") }
let out = URL(fileURLWithPath: "SFUBadminton/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png")
guard let dest = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil) else {
    fatalError("Cannot write \(out.path)")
}
CGImageDestinationAddImage(dest, image, nil)
guard CGImageDestinationFinalize(dest) else { fatalError("Cannot write \(out.path)") }
print("Wrote \(out.path)")
