package main

import (
	"archive/zip"
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// ---------------------------------------------------------------------------
// D-73 回归测试：媒体条目不得反向变大 + 逐条目最优重压
//
// 2026-10-24 用户报障「拖入 xlsx 点 Start，什么都没发生」。真根因：旧实现
// 对 media 图片强制 zip.Store，而源文件里这些 PNG 恰恰是 DEFLATE 压过的
// （比率 0.975）—— 存回去等于把压好的数据重新摊开，每张图涨 1.5~3%。
// media 占这类文件 98~99% 的体积，涨幅吃掉 XML 部分的收益，最终
// 「压缩后 ≥ 原文件」触发诚实回退删掉 output。
// ---------------------------------------------------------------------------

// buildTestZip 造一个「媒体为主」的 xlsx 形态 ZIP：一份可压的 XML + 一张
// 已经 DEFLATE 压过的 PNG（模拟 WPS/Excel 存出来的真实文件）。
func buildTestZip(t *testing.T, path string, pngData []byte) {
	t.Helper()
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	w := zip.NewWriter(f)

	// XML 部件：可压
	fw, err := w.CreateHeader(&zip.FileHeader{Name: "xl/worksheets/sheet1.xml", Method: zip.Deflate})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(bytes.Repeat([]byte("<row><c r=\"A1\"><v>123</v></c></row>"), 200)); err != nil {
		t.Fatal(err)
	}

	// 媒体部件：原文件用 DEFLATE 存（真实办公文档就是这样）
	fw, err = w.CreateHeader(&zip.FileHeader{Name: "xl/media/image1.png", Method: zip.Deflate})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write(pngData); err != nil {
		t.Fatal(err)
	}

	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
}

// opaquePNG 造一张带 alpha 通道但整体不透明的 PNG（colortype 6）。
//
// 刻意用高熵内容（渐变 + 确定性噪点）而不是纯色块：真实办公文档里的 PNG
// 是产品照片/截图，熵高。纯色块的常量 alpha 通道本身就能被 deflate 压没，
// 去 alpha 几乎不省体积 —— 那样测出来的「没变小」是测试图的性质，不是
// 算法的性质。真实样本实测单图 -34%（RGBA 的 bpp=4 滤波 vs RGB 的
// bpp=3，高熵图上差异显著）。
//
// 还必须**手工拼** colortype=6 的 PNG：Go 的 png.Encode 自带不透明检测
// （writer.go：opaque(m) 为真就写 cbTC8 / colortype 2），直接用它编码
// 根本不会产生 alpha 通道，也就根本测不到「去 alpha」这条路径。
func opaquePNG(t *testing.T) []byte {
	t.Helper()
	const w, h = 96, 96
	// 构造 RGBA 原始像素（高熵）
	raw := make([]byte, 0, h*(1+w*4))
	noise := uint32(12345)
	for y := 0; y < h; y++ {
		raw = append(raw, 0) // 每行的 filter type 0 (None)
		for x := 0; x < w; x++ {
			// xorshift32：确定性伪随机，保证测试可复现
			noise ^= noise << 13
			noise ^= noise >> 17
			noise ^= noise << 5
			raw = append(raw,
				uint8(x*2+int(noise&0x3F)),
				uint8(y*2+int((noise>>8)&0x3F)),
				uint8((noise>>16)&0xFF),
				255) // alpha 恒为 255 —— 这条通道是多余的
		}
	}
	return buildPNG(t, w, h, 6, raw)
}

// buildPNG 手工拼一个 PNG：signature + IHDR + IDAT + IEND。
// colorType 6 = RGBA，8 位深度。
func buildPNG(t *testing.T, w, h int, colorType byte, raw []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	buf.Write([]byte{0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A})

	var ihdr bytes.Buffer
	binary.Write(&ihdr, binary.BigEndian, uint32(w))
	binary.Write(&ihdr, binary.BigEndian, uint32(h))
	ihdr.WriteByte(8)         // bit depth
	ihdr.WriteByte(colorType) // color type
	ihdr.WriteByte(0)         // compression: deflate
	ihdr.WriteByte(0)         // filter method
	ihdr.WriteByte(0)         // interlace: none
	writeChunk(&buf, "IHDR", ihdr.Bytes())

	var idat bytes.Buffer
	zw := zlib.NewWriter(&idat)
	if _, err := zw.Write(raw); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	writeChunk(&buf, "IDAT", idat.Bytes())
	writeChunk(&buf, "IEND", nil)
	return buf.Bytes()
}

// writeChunk 写一个 PNG chunk（length + type + data + CRC32）。
func writeChunk(buf *bytes.Buffer, typ string, data []byte) {
	binary.Write(buf, binary.BigEndian, uint32(len(data)))
	typeStart := buf.Len()
	buf.WriteString(typ)
	buf.Write(data)
	crc := crc32.ChecksumIEEE(buf.Bytes()[typeStart:])
	binary.Write(buf, binary.BigEndian, crc)
}

// 关键回归：media 主导的 ZIP 重打包后必须**严格小于**源文件。
// 旧实现对 media 强制 zip.Store，输出反而比输入大 —— 这正是用户看到
// 「什么都没发生」的直接原因。
func TestRepackageNeverGrowsMediaDominantZip(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.xlsx")
	buildTestZip(t, src, opaquePNG(t))

	srcInfo, err := os.Stat(src)
	if err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(dir, "out.xlsx")
	if err := zipRepackageWithOptions(src, out, "default", "medium"); err != nil {
		t.Fatalf("zipRepackageWithOptions: %v", err)
	}
	outInfo, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if outInfo.Size() >= srcInfo.Size() {
		t.Errorf("output grew: %d -> %d (media must not be re-stored uncompressed)",
			srcInfo.Size(), outInfo.Size())
	}
}

// 输出的 ZIP 必须结构完整、部件齐全、顺序与源一致。
func TestRepackagePreservesEntriesAndOrder(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.xlsx")
	buildTestZip(t, src, opaquePNG(t))
	out := filepath.Join(dir, "out.xlsx")
	if err := zipRepackageWithOptions(src, out, "default", "medium"); err != nil {
		t.Fatalf("zipRepackageWithOptions: %v", err)
	}

	zr, err := zip.OpenReader(out)
	if err != nil {
		t.Fatalf("output is not a readable ZIP: %v", err)
	}
	defer zr.Close()
	if len(zr.File) != 2 {
		t.Fatalf("entry count = %d, want 2", len(zr.File))
	}
	if zr.File[0].Name != "xl/worksheets/sheet1.xml" || zr.File[1].Name != "xl/media/image1.png" {
		t.Errorf("entry order changed: %v", []string{zr.File[0].Name, zr.File[1].Name})
	}
	// 每个条目都必须能完整读出（CRC 正确 —— CreateRaw 走的是原样搬运，
	// CRC 写错会让 Excel 报「文件已损坏」）。
	for _, e := range zr.File {
		rc, err := e.Open()
		if err != nil {
			t.Fatalf("open %s: %v", e.Name, err)
		}
		if _, err := io.Copy(io.Discard, rc); err != nil {
			t.Errorf("read %s: %v", e.Name, err)
		}
		rc.Close()
	}
}

// PNG 去 alpha：整幅不透明时重编码成 RGB，体积必须变小，且**逐像素完全一致**。
func TestStripPNGAlphaIsPixelIdentical(t *testing.T) {
	src := opaquePNG(t)
	out := stripPNGAlpha(src)
	if len(out) >= len(src) {
		t.Fatalf("stripPNGAlpha did not shrink: %d -> %d", len(src), len(out))
	}
	a, err := png.Decode(bytes.NewReader(src))
	if err != nil {
		t.Fatal(err)
	}
	b, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	bounds := a.Bounds()
	if bounds != b.Bounds() {
		t.Fatalf("bounds changed: %v -> %v", bounds, b.Bounds())
	}
	for y := bounds.Min.Y; y < bounds.Max.Y; y++ {
		for x := bounds.Min.X; x < bounds.Max.X; x++ {
			r1, g1, b1, a1 := a.At(x, y).RGBA()
			r2, g2, b2, a2 := b.At(x, y).RGBA()
			if r1 != r2 || g1 != g2 || b1 != b2 || a1 != a2 {
				t.Fatalf("pixel (%d,%d) differs: %v -> %v", x, y,
					[]uint32{r1, g1, b1, a1}, []uint32{r2, g2, b2, a2})
			}
		}
	}
}

// 带真实透明度的 PNG 不能被去 alpha（否则会毁掉半透明效果）。
func TestStripPNGAlphaKeepsTransparency(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 32, 32))
	for y := 0; y < 32; y++ {
		for x := 0; x < 32; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: 200, G: 100, B: 50, A: uint8(x * 8)})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	src := buf.Bytes()
	if got := stripPNGAlpha(src); !bytes.Equal(got, src) {
		t.Error("transparent PNG was rewritten — transparency must be preserved")
	}
}

// default / print 档也要能吃到 PNG 去 alpha 的无损收益（它不涉及降采样）。
func TestShrinkMediaDataStripsAlphaInDefaultProfile(t *testing.T) {
	src := opaquePNG(t)
	got := shrinkMediaData(src, "default", "medium")
	if len(got) >= len(src) {
		t.Errorf("default profile did not strip alpha: %d -> %d", len(src), len(got))
	}
}

// cmdCompress 端到端：媒体主导的 xlsx 必须产出 outputPath（不能再是空）。
func TestCmdCompressProducesOutputForMediaDominantXlsx(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "doc.xlsx")
	buildTestZip(t, src, opaquePNG(t))

	res := cmdCompress(src, "default", "medium", 0)
	if res.Error != "" {
		t.Fatalf("unexpected error: %s", res.Error)
	}
	if res.OutputPath == "" {
		t.Fatal("no output produced — the honest fallback deleted it (D-73 regression)")
	}
	if _, err := os.Stat(res.OutputPath); err != nil {
		t.Fatalf("output missing: %v", err)
	}
	if res.CompressedSize >= res.OriginalSize {
		t.Errorf("output not smaller: %d -> %d", res.OriginalSize, res.CompressedSize)
	}
}

// 幂等：对已压缩产物再压一次，不应产出（已是最优），且不得留 tmp。
func TestCompressIsIdempotentOnAlreadyCompressed(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "doc.xlsx")
	buildTestZip(t, src, opaquePNG(t))

	first := cmdCompress(src, "default", "medium", 0)
	if first.Error != "" || first.OutputPath == "" {
		t.Fatalf("first pass failed: err=%q out=%q", first.Error, first.OutputPath)
	}
	second := cmdCompress(first.OutputPath, "default", "medium", 0)
	if second.Error != "" {
		t.Fatalf("second pass errored: %s", second.Error)
	}
	if second.OutputPath != "" {
		t.Errorf("second pass produced a file for an already-optimal input: %q", second.OutputPath)
	}
	if _, err := os.Stat(second.OutputPath + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("tmp orphan left behind: %v", err)
	}
}
