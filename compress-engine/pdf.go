package main

import (
	"context"
	"fmt"

	api "github.com/pdfcpu/pdfcpu/pkg/api"
)

// compressPDF optimizes a PDF via pdfcpu (Apache-2.0, pure Go — no cgo, so the
// CGO_ENABLED=0 cross-compile in CI is unaffected): prunes duplicate objects,
// re-compresses streams, and drops unused resources. Encrypted files surface a
// clear error from the library, which the UI shows as a per-file failure.
func compressPDF(input, profile, quality string, result CompressResult) CompressResult {
	if err := api.OptimizeFile(context.Background(), input, result.OutputPath, nil, nil); err != nil {
		result.Error = fmt.Sprintf("PDF compression failed: %v", err)
		return result
	}
	return result
}
