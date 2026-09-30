package main

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// zipRepackage copies a ZIP file (DOCX/XLSX/PPTX) with maximum compression.
func zipRepackage(input, output string) error {
	return zipRepackageWithOptions(input, output, "default", "medium")
}

// zipRepackageWithOptions copies a ZIP with per-format compression options.
func zipRepackageWithOptions(input, output, profile, quality string) error {
	reader, err := zip.OpenReader(input)
	if err != nil {
		return fmt.Errorf("cannot open as ZIP: %w", err)
	}
	defer reader.Close()

	outFile, err := os.Create(output)
	if err != nil {
		return fmt.Errorf("cannot create output: %w", err)
	}
	defer outFile.Close()

	writer := zip.NewWriter(outFile)
	defer writer.Close()

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
