package main

import (
	"fmt"
	"os"
)

// compressDocx reduces DOCX file size by re-compressing embedded images and
// re-zipping the OOXML parts with maximum compression.
func compressDocx(input, profile, quality string, result CompressResult) CompressResult {
	tmpOut := result.OutputPath + ".tmp"

	if err := optimizeZip(input, tmpOut, profile, quality); err != nil {
		// 失败也要清掉半成品 tmp：optimizeZip 里 os.Create 已建文件，
		// 中途出错不清理会留 "_compressed.docx.tmp" 孤儿（与 xlsx/pptx 同款）。
		os.Remove(tmpOut)
		result.Error = fmt.Sprintf("DOCX compression failed: %v", err)
		return result
	}

	// Rename temp to final output
	if err := os.Rename(tmpOut, result.OutputPath); err != nil {
		os.Remove(tmpOut)
		result.Error = fmt.Sprintf("failed to finalize output: %v", err)
		return result
	}

	return result
}

// optimizeZip re-zips the OOXML package with aggressive image recompression.
//
// 2026-10-24 findings D-73：DOCX 曾有一套自己的重打包实现，里面同样对媒体
// 强制 zip.Store —— 与 xlsx 路径同款根因（源文件里被 DEFLATE 压过的 PNG 被
// 重新摊开存回去，体积反而变大，最终「压缩后 ≥ 原文件」→ 诚实回退删掉
// 输出 → 用户看到「什么都没发生」）。
//
// 现在三条 OOXML 路径（xlsx / docx / pptx）统一走 zipRepackageWithOptions 的
// 「逐条目取最优」实现，媒体按魔数判定真实格式。
func optimizeZip(input, output, profile, quality string) error {
	return zipRepackageWithOptions(input, output, profile, quality)
}
