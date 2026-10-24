package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"fmt"
	"hash/crc32"
	"io"
	"os"
	"strings"
)

// zipRepackageWithOptions copies a ZIP with per-format compression options.
// 命名返回值 + defer：outFile.Close() 的错误并入返回（P0-18），失败路径也释放句柄。
//
// 核心策略：**逐条目取最优**，而不是给每个条目固定一种压缩方式。
//
// 2026-10-24 用户报障「拖入 xlsx 点 Start，只剩 TMP、没有压缩产物」深挖到的
// 真根因（见 findings D-73）：旧实现对 media 图片强制 zip.Store，而源文件里
// 这些 PNG 恰恰是 DEFLATE 压过的（比率 0.975）—— 存回去等于把已经压好的数据
// 重新摊开，每张图反而涨 1.5~3%。而这类文件 98~99% 的体积都是 media，涨幅
// 直接吃掉 XML 部分的压缩收益，最终「压缩后 ≥ 原文件」，诚实回退把 output 删
// 掉，用户看到的正是「什么都没发生」。
//
// 现在改为：对每个条目分别比较「重新压缩后的体积」与「原始压缩流的体积」，
// 取小的那个。原始压缩流用 zip.Writer.CreateRaw 原样搬运，不重新编码，
// 因此**任何情况下都不会比源文件更大**（前提是内容未被改动时才可回退）。
//
// 媒体额外收益（image.go）：PNG 若整体不透明，去掉恒为 255 的 alpha 通道后
// 重编码 —— 视觉零差异（逐像素比对 diff = 0），体积直降约 25~39%。
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
		// 目录条目：以原始 STORE 形式原样保留（内容为空）。
		if strings.HasSuffix(f.Name, "/") {
			if err := writeRawEntry(writer, f, nil); err != nil {
				return err
			}
			continue
		}

		// 读取该条目的原始压缩流（用于「不优就原样搬运」的兜底）。
		raw, err := readRawEntry(f)
		if err != nil {
			return err
		}

		// 读取解压后的内容（媒体需要按 profile/quality 处理）。
		original, err := readEntryData(f)
		if err != nil {
			return err
		}
		data := original

		// Downsample embedded media per profile (pptx/xlsx win big here).
		// 同时对 PNG 做去 alpha 重编码（视觉无损，见 image.go）。
		if strings.Contains(f.Name, "/media/") {
			data = shrinkMediaData(data, profile, quality)
		}

		// 逐条目最优：重新压缩，与原始压缩流比体积，取小的。
		recompressed, recErr := deflateBest(data)
		if recErr != nil {
			return fmt.Errorf("cannot compress ZIP entry %s: %w", f.Name, recErr)
		}

		// 内容被改动过（媒体优化）时，原始压缩流已与新内容不对应，
		// 只能写入重压结果 —— 否则会静默丢弃媒体优化成果。
		if !bytes.Equal(data, original) {
			if err := writeRecompressed(writer, f.Name, data, recompressed); err != nil {
				return err
			}
			continue
		}

		if len(recompressed) < len(raw) {
			// 重压更小：写入重压结果（Deflate）。
			if err := writeRecompressed(writer, f.Name, data, recompressed); err != nil {
				return err
			}
		} else {
			// 重压不更优：原样搬运原始压缩流（可能是 DEFLATE 也可能是 STORE）。
			if err := writeRawEntry(writer, f, raw); err != nil {
				return err
			}
		}
	}

	// zip.Writer.Close() 写中央目录，失败则文件不可读；必须显式上报（P0-18）
	if err := writer.Close(); err != nil {
		return fmt.Errorf("finalize zip: %w", err)
	}
	return nil
}

// readRawEntry returns the entry's stored (compressed) bytes verbatim.
func readRawEntry(f *zip.File) ([]byte, error) {
	rc, err := f.OpenRaw()
	if err != nil {
		return nil, fmt.Errorf("cannot read raw ZIP entry %s: %w", f.Name, err)
	}
	data, err := io.ReadAll(rc)
	if err != nil {
		return nil, fmt.Errorf("cannot read raw ZIP entry %s: %w", f.Name, err)
	}
	return data, nil
}

// readEntryData returns the entry's decompressed content.
func readEntryData(f *zip.File) ([]byte, error) {
	rc, err := f.Open()
	if err != nil {
		return nil, fmt.Errorf("cannot read ZIP entry %s: %w", f.Name, err)
	}
	data, err := io.ReadAll(rc)
	if err != nil {
		return nil, fmt.Errorf("cannot read ZIP entry %s: %w", f.Name, err)
	}
	return data, nil
}

// writeRecompressed writes freshly deflated bytes as a new entry.
func writeRecompressed(w *zip.Writer, name string, data, compressed []byte) error {
	hdr := &zip.FileHeader{
		Name:               name,
		Method:             zip.Deflate,
		CRC32:              crc32Of(data),
		CompressedSize64:   uint64(len(compressed)),
		UncompressedSize64: uint64(len(data)),
	}
	fw, err := w.CreateRaw(hdr)
	if err != nil {
		return fmt.Errorf("cannot create ZIP entry: %w", err)
	}
	if _, err := fw.Write(compressed); err != nil {
		return fmt.Errorf("cannot write ZIP entry: %w", err)
	}
	return nil
}

// writeRawEntry copies an entry's stored bytes into the output archive without
// re-encoding them. raw == nil means "read it from the source file".
func writeRawEntry(w *zip.Writer, f *zip.File, raw []byte) error {
	if raw == nil {
		var err error
		raw, err = readRawEntry(f)
		if err != nil {
			return err
		}
	}
	hdr := &zip.FileHeader{
		Name:               f.Name,
		Method:             f.Method,
		CRC32:              f.CRC32,
		CompressedSize64:   f.CompressedSize64,
		UncompressedSize64: f.UncompressedSize64,
	}
	fw, err := w.CreateRaw(hdr)
	if err != nil {
		return fmt.Errorf("cannot create ZIP entry: %w", err)
	}
	if len(raw) == 0 {
		return nil
	}
	if _, err := fw.Write(raw); err != nil {
		return fmt.Errorf("cannot write ZIP entry: %w", err)
	}
	return nil
}

// crc32Of returns the IEEE CRC-32 checksum of data — the same checksum the
// ZIP format uses for each entry.
func crc32Of(data []byte) uint32 {
	return crc32.ChecksumIEEE(data)
}

// deflateBest compresses data with the strongest deflate setting.
func deflateBest(data []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw, err := flate.NewWriter(&buf, flate.BestCompression)
	if err != nil {
		return nil, err
	}
	if _, err := zw.Write(data); err != nil {
		zw.Close()
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
