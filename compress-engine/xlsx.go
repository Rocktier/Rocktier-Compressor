package main

import (
	"fmt"
	"os"
)

// compressXlsx reduces XLSX file size.
// MVP: re-compress the OOXML package (XLSX is a ZIP of XML + binaries).
func compressXlsx(input, profile, quality string, result CompressResult) CompressResult {
	tmpOut := result.OutputPath + ".tmp"

	if err := optimizeXlsxZip(input, tmpOut, profile, quality); err != nil {
		// 失败也要清掉半成品 tmp：os.Create 已经建了文件，中途出错不清理
		// 会在用户目录里留下 "_compressed.xlsx.tmp" 孤儿（2026-10-24 实测复现）。
		os.Remove(tmpOut)
		result.Error = fmt.Sprintf("XLSX compression failed: %v", err)
		return result
	}

	if err := moveFile(tmpOut, result.OutputPath); err != nil {
		result.Error = fmt.Sprintf("failed to finalize XLSX output: %v", err)
		os.Remove(tmpOut)
		return result
	}

	return result
}

// optimizeXlsxZip re-packages the XLSX ZIP with maximum compression.
// In production, excelize would be used for formula re-calculation if needed.
// profile/quality 直接穿透到 zipRepackageWithOptions（驱动内嵌 media 的
// shrinkMediaData 降采样），不再回退到 default/medium 默认值。
func optimizeXlsxZip(input, output, profile, quality string) error {
	return zipRepackageWithOptions(input, output, profile, quality)
}

// moveFile moves src to dst **and removes src**. The previous implementation
// was ReadFile + WriteFile only — a copy, not a move — so every XLSX compress
// left a "_compressed.xlsx.tmp" orphan next to the output (2026-10-24 user
// report + local repro: "only a TMP file shows up, no compressed file").
// rename first (same volume, atomic); fall back to copy+remove when rename
// fails (cross-volume temp dirs, some network filesystems). os.WriteFile
// truncates, so the fallback correctly overwrites an existing dst.
func moveFile(src, dst string) error {
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
