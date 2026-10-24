package main

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"os"

	"golang.org/x/image/draw"
	"golang.org/x/image/tiff"
)

// jpegQuality maps the UI quality chip to an encode quality. The ladder is
// borrowed from the Rocktier Pic2Webp family presets (Smaller 60 / Balanced 80
// / Better 95) so "Balanced" feels the same across family apps.
func jpegQuality(quality string) int {
	switch quality {
	case "low":
		return 60
	case "high":
		return 95
	default:
		return 80
	}
}

// maxImageEdge returns the profile's long-edge resize cap in pixels (0 = keep
// original dimensions). Profiles mirror getProfiles() descriptions in main.go:
//   web     "optimised for web upload"  -> 1920px
//   screen  "screen display only"       -> 1280px
//   maximum "smallest file, lossy"      -> 1024px
//   default/print                       -> no resize (preserve dimensions)
func maxImageEdge(profile string) int {
	switch profile {
	case "web":
		return 1920
	case "screen":
		return 1280
	case "maximum":
		return 1024
	default:
		return 0
	}
}

// compressImage reduces an image by re-encoding at the family quality ladder.
func compressImage(input, profile, quality string, result CompressResult) CompressResult {
	if err := reencodeImage(input, result.OutputPath, profile, quality); err != nil {
		result.Error = fmt.Sprintf("Image compression failed: %v", err)
		return result
	}
	return result
}

// reencodeImage decodes the source, optionally downsamples the long edge to
// the profile cap, and re-encodes. Going through Go's image packages also
// strips EXIF/GPS metadata — a deliberate privacy win, matching family apps.
func reencodeImage(input, output, profile, quality string) error {
	src, err := loadImage(input)
	if err != nil {
		return fmt.Errorf("cannot decode image: %w", err)
	}

	if limit := maxImageEdge(profile); limit > 0 {
		src = downsample(src, limit)
	}

	out, err := os.Create(output)
	if err != nil {
		return fmt.Errorf("cannot create output: %w", err)
	}
	defer out.Close()

	switch detectFormat(input) {
	case "jpeg":
		q := jpegQuality(quality)
		if profile == "maximum" {
			q = jpegQuality("low")
		}
		return jpeg.Encode(out, src, &jpeg.Options{Quality: q})
	case "png":
		if quality == "low" || profile == "maximum" {
			// Screenshots and flat artwork shrink enormously with a
			// 256-color palette; acceptable loss at "low" quality.
			return png.Encode(out, quantize256(src))
		}
		enc := png.Encoder{CompressionLevel: png.BestCompression}
		return enc.Encode(out, src)
	case "tiff":
		return tiff.Encode(out, src, &tiff.Options{Compression: tiff.Deflate})
	default:
		return fmt.Errorf("unsupported image format: %s", detectFormat(input))
	}
}

func loadImage(path string) (image.Image, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	img, _, err := image.Decode(f)
	return img, err
}

// encodeImage serializes img in the given format; q <= 60 triggers 256-color
// quantization for PNG (the "make it small" lever PNG otherwise lacks).
func encodeImage(format string, img image.Image, q int) ([]byte, error) {
	var buf bytes.Buffer
	switch format {
	case "jpeg":
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: q}); err != nil {
			return nil, err
		}
	case "png":
		enc := png.Encoder{CompressionLevel: png.BestCompression}
		var err error
		if q <= 60 {
			err = enc.Encode(&buf, quantize256(img))
		} else {
			err = enc.Encode(&buf, img)
		}
		if err != nil {
			return nil, err
		}
	case "tiff":
		if err := tiff.Encode(&buf, img, &tiff.Options{Compression: tiff.Deflate}); err != nil {
			return nil, err
		}
	default:
		return nil, fmt.Errorf("unsupported image format: %s", format)
	}
	return buf.Bytes(), nil
}

// targetResizeLadder: long-edge caps tried from gentlest to most aggressive.
var targetResizeLadder = []int{0, 1920, 1280, 1024, 800, 640, 480}

// compressImageToTarget searches (resize rung × encode quality) until the
// output fits the target byte budget. JPEG binary-searches quality per rung;
// PNG/TIFF walk their fixed levers. Returns a note when the target is
// unreachable — we keep the smallest attempt and say so instead of lying.
func compressImageToTarget(input, output, profile, quality string, target int64) (string, error) {
	src, err := loadImage(input)
	if err != nil {
		return "", fmt.Errorf("cannot decode image: %w", err)
	}
	format := detectFormat(input)
	startQ := jpegQuality(quality)

	best := make([]byte, 0)
	bestSize := int64(1) << 62
	consider := func(data []byte, err error) {
		if err != nil || len(data) == 0 {
			return
		}
		if int64(len(data)) < bestSize {
			bestSize = int64(len(data))
			best = data
		}
	}

	for _, rung := range targetResizeLadder {
		img := src
		if rung > 0 {
			img = downsample(src, rung)
		}
		if format == "jpeg" {
			lo, hi := 30, 95
			var fit []byte
			for lo <= hi {
				mid := (lo + hi) / 2
				data, err := encodeImage(format, img, mid)
				if err != nil {
					return "", err
				}
				if int64(len(data)) <= target {
					fit = data
					lo = mid + 1
				} else {
					consider(data, nil)
					hi = mid - 1
				}
			}
			if fit != nil {
				if err := os.WriteFile(output, fit, 0644); err != nil {
					return "", err
				}
				return "", nil
			}
		} else {
			for _, q := range []int{startQ, 60} {
				data, err := encodeImage(format, img, q)
				consider(data, err)
				if err == nil && int64(len(data)) <= target {
					if err := os.WriteFile(output, data, 0644); err != nil {
						return "", err
					}
					return "", nil
				}
			}
		}
	}

	if len(best) == 0 {
		return "", fmt.Errorf("cannot encode image")
	}
	if err := os.WriteFile(output, best, 0644); err != nil {
		return "", err
	}
	return "未能压到目标大小，这已是最小 / Could not reach the target — this is the smallest we got", nil
}

// shrinkMediaData re-encodes an embedded Office image (JPEG/PNG/TIFF bytes)
// down to the profile's long-edge cap. Returns the original bytes untouched
// when the entry is not a media image, decoding fails, or the re-encode is
// not smaller — media substitution must never corrupt or grow the document.
//
// Two distinct levers live here (2026-10-24 findings D-73):
//
//  1. **PNG 去 alpha（视觉无损）** —— 办公文档里的 PNG 常带一条恒为 255 的
//     alpha 通道（colortype 6）。整幅图不透明时，把 RGBA 重编码成 RGB 是
//     逐像素等价的（实测 rgbDiffs=0 / alphaDiffs=0），却省掉 1/4 的原始像素
//     数据，实测单图 -33~34%。这一条 **不涉及任何降采样**，因此对 default /
//     print 档同样适用 —— 它不损画质，只丢掉一个恒定通道。
//
//  2. **降采样（有损）** —— 只在 profile 给了长边上限时才做（web / screen /
//     maximum）。default / print 档上限为 0，保持原尺寸。
func shrinkMediaData(data []byte, profile, quality string) []byte {
	limit := maxImageEdge(profile)

	// 按**魔数**判定真实格式，而不是扩展名 —— Office 允许扩展名与实际格式
	// 不符（实测：xl/media/image4.png 的内容其实是 JPEG）。按扩展名分派会
	// 把 JPEG 当 PNG 解（失败，安全但错失收益），或把 PNG 当 JPEG 解。
	// 魔数不认识的（.emf/.wmf 矢量图等）一律原样保留。
	format := sniffImageFormat(data)
	if format == "" {
		return data
	}

	// PNG：先去 alpha（无损，所有档位都做），再按需降采样（有损，仅有上限档）。
	if format == "png" {
		stripped := stripPNGAlpha(data)
		if len(stripped) < len(data) {
			data = stripped
		}
	}

	if limit == 0 {
		return data // default/print profiles preserve embedded media dimensions
	}

	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return data
	}
	out, err := encodeImage(format, downsample(img, limit), jpegQuality(quality))
	if err != nil || len(out) >= len(data) {
		return data
	}
	return out
}

// sniffImageFormat detects the real image format from the leading magic
// bytes, returning "png" / "jpeg" / "tiff" or "" when unrecognised.
// Office documents are known to store JPEG data under a .png name, so the
// file extension cannot be trusted.
func sniffImageFormat(data []byte) string {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A}):
		return "png"
	case len(data) >= 3 && data[0] == 0xFF && data[1] == 0xD8 && data[2] == 0xFF:
		return "jpeg"
	case len(data) >= 4 && (bytes.Equal(data[:4], []byte{'I', 'I', 0x2A, 0x00}) ||
		bytes.Equal(data[:4], []byte{'M', 'M', 0x00, 0x2A})):
		return "tiff"
	}
	return ""
}

// stripPNGAlpha re-encodes a PNG that carries a fully-opaque alpha channel
// into an equivalent RGB PNG. When every pixel's alpha is 255 the conversion
// is pixel-identical (verified by per-pixel comparison), so the image looks
// exactly the same while carrying 25% less raw pixel data.
//
// Returns the original bytes unchanged when the PNG has no alpha channel,
// has a partially transparent pixel, fails to decode, or the re-encode does
// not actually come out smaller.
func stripPNGAlpha(data []byte) []byte {
	img, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return data
	}
	// Go's PNG decoder hands back *image.NRGBA / *image.RGBA for images that
	// carry an alpha channel. Anything else (Gray, Paletted, NRGBA64…) has no
	// alpha to strip.
	switch img.(type) {
	case *image.NRGBA, *image.RGBA:
	default:
		return data
	}
	if !isFullyOpaque(img) {
		return data
	}
	var buf bytes.Buffer
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	if err := enc.Encode(&buf, img); err != nil {
		return data
	}
	if buf.Len() >= len(data) {
		return data
	}
	return buf.Bytes()
}

// isFullyOpaque reports whether every pixel of img has alpha == 0xff.
func isFullyOpaque(img image.Image) bool {
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if _, _, _, a := img.At(x, y).RGBA(); a != 0xffff {
				return false
			}
		}
	}
	return true
}

// downsample scales the image so its long edge fits limit (never upscales).
func downsample(src image.Image, limit int) image.Image {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	long := w
	if h > long {
		long = h
	}
	if long <= limit {
		return src
	}
	s := float64(limit) / float64(long)
	nw := max(1, int(float64(w)*s))
	nh := max(1, int(float64(h)*s))
	dst := image.NewRGBA(image.Rect(0, 0, nw, nh))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Src, nil)
	return dst
}

// quantize256 converts to a 256-color palette with Floyd-Steinberg dithering:
// a 6x6x6 RGB cube (216) plus a 40-step grayscale ramp = exactly 256 entries.
func quantize256(src image.Image) image.Image {
	b := src.Bounds()
	pm := image.NewPaletted(b, palette256)
	draw.FloydSteinberg.Draw(pm, b, src, b.Min)
	return pm
}

var palette256 = buildPalette()

func buildPalette() color.Palette {
	var pal color.Palette
	for r := 0; r < 6; r++ {
		for g := 0; g < 6; g++ {
			for b := 0; b < 6; b++ {
				pal = append(pal, color.RGBA{uint8(r * 51), uint8(g * 51), uint8(b * 51), 255})
			}
		}
	}
	for i := 0; i < 40; i++ {
		v := uint8(i * 255 / 39)
		pal = append(pal, color.RGBA{v, v, v, 255})
	}
	return pal
}
