package main

import (
	"fmt"
	"os"
)

// compressPptx reduces PPTX file size by re-compressing embedded media.
func compressPptx(input, profile, quality string, result CompressResult) CompressResult {
	tmpOut := result.OutputPath + ".tmp"

	if err := optimizePptxZip(input, tmpOut, profile, quality); err != nil {
		// 同 compressXlsx：失败路径清掉半成品 tmp，不留孤儿文件。
		os.Remove(tmpOut)
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

// moveFilePptx is moveFile under the PPTX name (kept so the two format
// pipelines stay independent): rename first, copy+remove fallback. The old
// copy-only version never removed src — same "_compressed.pptx.tmp" orphan
// bug as xlsx.go (2026-10-24).
func moveFilePptx(src, dst string) error {
	if err := os.Rename(src, dst); err == nil {
		return nil
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return err
	}
	return os.Remove(src)
}
