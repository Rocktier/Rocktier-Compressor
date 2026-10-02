package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// zipRepackageWithOptions copies a ZIP with per-format compression options.
// 命名返回值 + defer：outFile.Close() 的错误并入返回（P0-18），失败路径也释放句柄。
func zipRepackageWithOptions(input, output, profile, quality string) (err error) {
	reader, err := zip.OpenReader(input)
	if err != nil {
		return fmt.Errorf("cannot open as ZIP: %w", err)
	}
	defer reader.Close()

	outFile, err := os.Create(output)
	if err != nil {
		return fmt.Errorf("cannot create output: %w", err)
	}
	defer func() {
		if closeErr := outFile.Close(); err == nil && closeErr != nil {
			err = fmt.Errorf("close output: %w", closeErr)
		}
	}()

	writer := zip.NewWriter(outFile)

	for _, f := range reader.File {
		rc, err := f.Open()
		if err != nil {
			rc.Close()
			return fmt.Errorf("cannot read ZIP entry %s: %w", f.Name, err)
		}

		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return fmt.Errorf("cannot read entry data: %w", err)
		}

		// Downsample embedded media per profile (pptx/xlsx win big here).
		if strings.Contains(f.Name, "/media/") {
			data = shrinkMediaData(data, f.Name, profile, quality)
		}

		// Select compression method based on content type
		method := selectCompressionMethod(f.Name, profile, quality, data)

		fw, err := writer.CreateHeader(&zip.FileHeader{
			Name:   f.Name,
			Method: method,
		})
		if err != nil {
			return fmt.Errorf("cannot create ZIP entry: %w", err)
		}
		if _, err := fw.Write(data); err != nil {
			return fmt.Errorf("cannot write ZIP entry: %w", err)
		}
	}

	// zip.Writer.Close() 写中央目录，失败则文件不可读；必须显式上报（P0-18）
	if err := writer.Close(); err != nil {
		return fmt.Errorf("finalize zip: %w", err)
	}
	return nil
}

// selectCompressionMethod returns ZIP method based on file type and profile.
func selectCompressionMethod(name, profile, quality string, data []byte) uint16 {
	ext := strings.ToLower(filepath.Ext(name))

	// Already-compressed formats: store as-is to save CPU
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".mp4", ".mp3", ".zip", ".gz":
		return zip.Store
	}

	// XML/text parts: always use best compression
	if strings.HasSuffix(ext, ".xml") || strings.HasSuffix(ext, ".rels") {
		return zip.Deflate
	}

	// For images in media/, apply quality-based recompression (future)
	if strings.Contains(name, "/media/") {
		return zip.Deflate
	}

	return zip.Deflate
}
