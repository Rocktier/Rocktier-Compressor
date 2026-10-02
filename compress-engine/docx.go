package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// compressDocx reduces DOCX file size by re-compressing embedded images and
// re-zipping the OOXML parts with maximum compression.
func compressDocx(input, profile, quality string, result CompressResult) CompressResult {
	// Create temp output
	tmpOut := result.OutputPath + ".tmp"

	if err := optimizeZip(input, tmpOut, profile, quality); err != nil {
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
func optimizeZip(input, output, profile, quality string) error {
	reader, err := zip.OpenReader(input)
	if err != nil {
		return fmt.Errorf("cannot open DOCX as ZIP: %w", err)
	}
	defer reader.Close()

	outFile, err := os.Create(output)
	if err != nil {
		return fmt.Errorf("cannot create output: %w", err)
	}
	defer outFile.Close()

	writer := zip.NewWriter(outFile)

	for _, f := range reader.File {
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("cannot read ZIP entry %s: %w", f.Name, err)
		}

		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			return fmt.Errorf("cannot read entry data: %w", err)
		}

		// Re-compress embedded images based on profile/quality
		if isImageInDocx(f.Name) {
			data = shrinkMediaData(data, f.Name, profile, quality)
		}

		// Always store XML parts with best compression
		method := zip.Deflate
		if isAlreadyCompressed(f.Name) {
			method = zip.Store
		}

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

	// zip.Writer.Close() 写中央目录，失败则文件不可读（Word 打不开）；必须显式上报，不能静默丢弃（P0-18）
	if err := writer.Close(); err != nil {
		return fmt.Errorf("finalize zip: %w", err)
	}
	return nil
}

// isImageInDocx checks if the ZIP entry path contains media/images.
func isImageInDocx(name string) bool {
	return strings.HasPrefix(name, "word/media/") ||
		strings.HasPrefix(name, "word/_rels/") ||
		strings.Contains(name, "/media/")
}

// isAlreadyCompressed checks extensions that are already binary/compressed.
func isAlreadyCompressed(name string) bool {
	ext := strings.ToLower(filepath.Ext(name))
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".mp4", ".mp3", ".zip":
		return true
	}
	return false
}
