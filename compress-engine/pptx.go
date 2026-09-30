package main

import (
	"fmt"
	"os"
)

// compressPptx reduces PPTX file size by re-compressing embedded media.
func compressPptx(input, profile, quality string, result CompressResult) CompressResult {
	tmpOut := result.OutputPath + ".tmp"

	if err := optimizePptxZip(input, tmpOut, profile, quality); err != nil {
		result.Error = fmt.Sprintf("PPTX compression failed: %v", err)
		return result
	}

	if err := moveFilePptx(tmpOut, result.OutputPath); err != nil {
		result.Error = fmt.Sprintf("failed to finalize PPTX output: %v", err)
		os.Remove(tmpOut)
		return result
	}

	return result
}

// optimizePptxZip re-packages PPTX with maximum compression and optional
// image quality reduction.
func optimizePptxZip(input, output, profile, quality string) error {
	return zipRepackageWithOptions(input, output, profile, quality)
}

func moveFilePptx(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}
