package main

import (
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
