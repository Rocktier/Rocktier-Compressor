package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// CompressResult mirrors the JSON returned to the Rust frontend.
type CompressResult struct {
	InputPath     string  `json:"inputPath"`
	OutputPath    string  `json:"outputPath"`
	OriginalSize  int64   `json:"originalSize"`
	CompressedSize int64  `json:"compressedSize"`
	Ratio         float64 `json:"ratio"`
	Format        string  `json:"format"`
	Error         string  `json:"error,omitempty"`
}

// Profile represents a named compression preset.
type Profile struct {
	Name        string  `json:"name"`
	Label       string  `json:"label"`
	Description string  `json:"description"`
	Quality     string  `json:"quality"`
}

// detectFormat returns the compression category for a given file path.
func detectFormat(path string) string {
	ext := strings.ToLower(filepath.Ext(path))
	switch ext {
	case ".pdf":
		return "pdf"
	case ".docx", ".docm", ".dotx":
		return "docx"
	case ".xlsx", ".xlsm", ".xltx":
		return "xlsx"
	case ".pptx", ".pptm", ".potx":
		return "pptx"
	case ".jpg", ".jpeg":
		return "jpeg"
	case ".png":
		return "png"
	case ".tiff", ".tif":
		return "tiff"
	default:
		return "unknown"
	}
}

// outputFile generates the output path (e.g., "report_compressed.pdf" or "report_compressed.docx").
func outputFile(input string) string {
	ext := filepath.Ext(input)
	base := strings.TrimSuffix(input, ext)
	return base + "_compressed" + ext
}

// cmdCompress routes a single file to the correct pipeline based on detected format.
func cmdCompress(input, profile, quality string) {
	info, err := os.Stat(input)
	if err != nil {
		outputError(input, fmt.Sprintf("cannot stat input: %v", err))
		return
	}

	format := detectFormat(input)
	result := CompressResult{
		InputPath:    input,
		OutputPath:   outputFile(input),
		OriginalSize: info.Size(),
		Format:       format,
	}

	switch format {
	case "pdf":
		result = compressPDF(input, profile, quality, result)
	case "docx":
		result = compressDocx(input, profile, quality, result)
	case "xlsx":
		result = compressXlsx(input, profile, quality, result)
	case "pptx":
		result = compressPptx(input, profile, quality, result)
	case "jpeg", "png", "tiff":
		result = compressImage(input, profile, quality, result)
	default:
		result.Error = fmt.Sprintf("unsupported format: %s", format)
	}

	if result.Error == "" {
		if outInfo, err := os.Stat(result.OutputPath); err == nil {
			result.CompressedSize = outInfo.Size()
			if result.OriginalSize > 0 {
				result.Ratio = float64(result.CompressedSize) / float64(result.OriginalSize)
			}
		}
	}

	outputJSON(result)
}

func outputError(input, msg string) {
	outputJSON(CompressResult{InputPath: input, Error: msg})
}

func outputJSON(v interface{}) {
	enc := json.NewEncoder(os.Stdout)
	_ = enc.Encode(v)
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: compress-engine <command> [args...]")
		os.Exit(1)
	}

	switch os.Args[1] {
	case "compress":
		if len(os.Args) < 6 {
			fmt.Fprintln(os.Stderr, "usage: compress-engine compress --input <path> --profile <name> --quality <q>")
			os.Exit(1)
		}
		input, profile, quality := parseFlags(os.Args[2:])
		cmdCompress(input, profile, quality)

	case "batch":
		args := os.Args[2:]
		profile := "default"
		quality := "medium"
		var paths []string
		for i := 0; i < len(args); i++ {
			switch args[i] {
			case "--profile":
				profile = args[i+1]
				i++
			case "--quality":
				quality = args[i+1]
				i++
			default:
				paths = append(paths, args[i])
			}
		}
		for _, p := range paths {
			cmdCompress(p, profile, quality)
		}

	case "profiles":
		json.NewEncoder(os.Stdout).Encode(getProfiles())

	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n", os.Args[1])
		os.Exit(1)
	}
}

// parseFlags extracts named flags from argument list.
func parseFlags(args []string) (input, profile, quality string) {
	profile = "default"
	quality = "medium"
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--input":
			input = args[i+1]
			i++
		case "--profile":
			profile = args[i+1]
			i++
		case "--quality":
			quality = args[i+1]
			i++
		}
	}
	return
}

// getProfiles returns the built-in compression profiles.
func getProfiles() []Profile {
	return []Profile{
		{Name: "default", Label: "默认 / Default", Description: "平衡质量与体积 / Balanced quality and size", Quality: "medium"},
		{Name: "web", Label: "网页 / Web", Description: "优化用于网页上传 / Optimised for web upload", Quality: "low"},
		{Name: "print", Label: "打印 / Print", Description: "保留打印质量 / Preserve print quality", Quality: "high"},
		{Name: "screen", Label: "屏幕 / Screen", Description: "屏幕显示即可 / Screen display only", Quality: "low"},
		{Name: "maximum", Label: "极限 / Maximum", Description: "最小文件，质量可损 / Smallest file, quality lossy", Quality: "low"},
	}
}
