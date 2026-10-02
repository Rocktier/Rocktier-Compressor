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

func moveFile(src, dst string) error {
	data, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	return os.WriteFile(dst, data, 0644)
}
