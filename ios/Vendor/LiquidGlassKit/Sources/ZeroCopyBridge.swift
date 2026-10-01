//
//  ZeroCopyBridge.swift
//  LiquidGlass
//
//  Created by Alexey Demin on 2025-12-22.
//
//  Vendored modification (2026-10-01) — 单缓冲改多缓冲 + 尺寸未变不重建：
//  1. 单缓冲时 CPU 每帧覆写的那块 IOSurface，正是 GPU 上一两帧还在采样的那块
//     （无 fence/信号量，MTKView 的 drawable 队列有深度）→ 撕裂；更要命的是
//     LiquidGlassView「均匀帧沿用上一帧纹理」的兜底完全失效——所谓「上一帧纹理」
//     和刚渲染出来的纹理是同一个 MTLTexture 对象，内容早被新帧覆盖了。
//     轮转 3 块后：GPU 落后一两帧也不会被追写，回退逻辑才真的回退到上一帧内容。
//  2. setupBuffer 每次调用都重建 IOSurface：透镜按加速度做挤压/拉伸时
//     bounds 逐帧变化，layoutSubviews 每帧都会走到这里，逐帧重建既贵又会让
//     GPU 正在采样的旧纹理立刻作废。尺寸未变直接返回。
//

import CoreVideo

class ZeroCopyBridge {
    let device: MTLDevice
    var textureCache: CVMetalTextureCache?

    /// 轮转缓冲数（见文件头注释）
    private static let bufferCount = 3
    private var pixelBuffers: [CVPixelBuffer?] = Array(repeating: nil, count: ZeroCopyBridge.bufferCount)
    private var cvTextures: [CVMetalTexture?] = Array(repeating: nil, count: ZeroCopyBridge.bufferCount)
    private var writeIndex = 0

    /// 已分配缓冲的像素尺寸（0 = 尚未分配）
    private var allocatedWidth = 0
    private var allocatedHeight = 0

    /// 最近一次 render 写入的像素缓冲。LiquidGlassView 在 render 的 actions 闭包内
    /// （缓冲锁定期）读它做稀疏采样，判断「均匀黑帧」与背景是否在变化。
    var pixelBuffer: CVPixelBuffer? { pixelBuffers[writeIndex] }

    init(device: MTLDevice) {
        self.device = device
        let status = CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &textureCache)
        if status != kCVReturnSuccess {
            print("Failed to create texture cache: \(status)")
        }
    }

    func setupBuffer(width: Int, height: Int) {
        guard width > 0, height > 0 else { return }
        // 尺寸没变就不重建（见文件头注释 2）
        guard width != allocatedWidth || height != allocatedHeight || pixelBuffers[0] == nil else { return }

        let attrs = [
            kCVPixelBufferMetalCompatibilityKey: true,
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:] // Enables zero-copy via IOSurface
        ] as CFDictionary

        for index in 0..<Self.bufferCount {
            var buffer: CVPixelBuffer?
            let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA, attrs, &buffer)
            if status != kCVReturnSuccess {
                print("Failed to create pixel buffer: \(status)")
            }
            pixelBuffers[index] = buffer

            guard let buffer, let cache = textureCache else {
                cvTextures[index] = nil
                continue
            }

            // Create the Metal Texture wrapper for the CVPixelBuffer
            var cvTexture: CVMetalTexture?
            CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, cache, buffer, nil, .bgra8Unorm, width, height, 0, &cvTexture)
            cvTextures[index] = cvTexture
        }

        allocatedWidth = width
        allocatedHeight = height
        writeIndex = 0
    }

    func render(actions: (CGContext) -> Void) -> MTLTexture? {
        guard let cache = textureCache else { return nil }

        // 轮转到下一块：上一帧（乃至上上帧）的纹理内容保持原样，
        // 供 LiquidGlassView 的「均匀帧沿用上一帧」使用
        writeIndex = (writeIndex + 1) % Self.bufferCount
        guard let buffer = pixelBuffers[writeIndex] else { return nil }

        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)

        // Lock for CPU writing
        CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags(rawValue: 0))
        defer {
            // Unlock and flush to propagate changes to GPU
            CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags(rawValue: 0))
            CVMetalTextureCacheFlush(cache, 0)
        }

        let data = CVPixelBufferGetBaseAddress(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)

        // Create CGContext from shared memory
        guard let context = CGContext(
            data: data,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        ) else {
            return nil
        }

        actions(context)

        // Get MTLTexture from the retained CVMetalTexture
        return cvTextures[writeIndex].flatMap { CVMetalTextureGetTexture($0) }
    }
}
