package main

import (
	"context"
	"fmt"

	api "github.com/pdfcpu/pdfcpu/pkg/api"
	"github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

// compressPDF optimizes a PDF via pdfcpu (Apache-2.0, pure Go — no cgo, so the
// CGO_ENABLED=0 cross-compile in CI is unaffected): prunes duplicate objects,
// re-compresses streams, and drops unused resources. Encrypted files surface a
// clear error from the library, which the UI shows as a per-file failure.
func compressPDF(input, profile, quality string, result CompressResult) CompressResult {
	// pdfcpu v0.16 的 OptimizeFile 接受 *model.Configuration。其中唯一可由
	// profile 驱动的真实压缩开关是 OptimizeDuplicateContentStreams（默认关
	// 闭，见 pdfcpu optimize.go:1088 的消费点）：跨页去重相同的内容流。
	// quality 在 v0.16 没有对应参数（无图像重编码配置），不假装穿透。
	conf := model.NewDefaultConfiguration()
	if profile == "maximum" {
		conf.OptimizeDuplicateContentStreams = true
	}
	if err := api.OptimizeFile(context.Background(), input, result.OutputPath, conf, nil); err != nil {
		result.Error = fmt.Sprintf("PDF compression failed: %v", err)
		return result
	}
	return result
}
