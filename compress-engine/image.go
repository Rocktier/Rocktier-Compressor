package main

import (
	"fmt"
	"os"
)

// compressImage reduces image file size via re-encoding at lower quality.
func compressImage(input, profile, quality string, result CompressResult) CompressResult {
	if err := reencodeImage(input, result.OutputPath, profile, quality); err != nil {
		result.Error = fmt.Sprintf("Image compression failed: %v", err)
		return result
	}
	return result
}

// reencodeImage re-encodes the source image at the target quality.
// Production: link bimg (libvips) for JPEG/PNG/WEBP, or Go image libraries.
func reencodeImage(input, output, profile, quality string) error {
	// TODO: integrate bimg or image/jpeg, image/png with quality settings
	// For now, copy as-is (structure scaffold)
	data, err := os.ReadFile(input)
	if err != nil {
		return err
	}
	return os.WriteFile(output, data, 0644)
}
