package main

import (
	"os"
	"path/filepath"
	"testing"
)

// moveFile / moveFilePptx must be real moves: after the call, src must not
// exist. The 2026-10-24 user report ("only a TMP file shows up, no compressed
// file") traced to the previous ReadFile+WriteFile-only implementations, which
// copied but never removed the source — every xlsx/pptx compress left a
// "_compressed.<ext>.tmp" orphan next to the output.
func TestMoveFileRemovesSource(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	dst := filepath.Join(dir, "dst.bin")
	if err := os.WriteFile(src, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := moveFile(src, dst); err != nil {
		t.Fatalf("moveFile: %v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Errorf("src still exists after moveFile: %v", err)
	}
	data, err := os.ReadFile(dst)
	if err != nil || string(data) != "hello" {
		t.Errorf("dst content wrong: %q %v", data, err)
	}
}

func TestMoveFilePptxRemovesSource(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	dst := filepath.Join(dir, "dst.bin")
	if err := os.WriteFile(src, []byte("pptx"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := moveFilePptx(src, dst); err != nil {
		t.Fatalf("moveFilePptx: %v", err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Errorf("src still exists after moveFilePptx: %v", err)
	}
	data, err := os.ReadFile(dst)
	if err != nil || string(data) != "pptx" {
		t.Errorf("dst content wrong: %q %v", data, err)
	}
}

// Overwriting an existing dst must produce exactly the src content — the
// copy fallback must truncate, never append (os.WriteFile does; guard it).
// The engine's os.Create writes also silently overwrite existing outputs, and
// the frontend confirms conflicts before starting, so overwrite is expected.
func TestMoveFileOverwritesExistingDst(t *testing.T) {
	dir := t.TempDir()
	src := filepath.Join(dir, "src.bin")
	dst := filepath.Join(dir, "dst.bin")
	if err := os.WriteFile(src, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dst, []byte("much longer existing content"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := moveFile(src, dst); err != nil {
		t.Fatalf("moveFile: %v", err)
	}
	data, err := os.ReadFile(dst)
	if err != nil || string(data) != "new" {
		t.Errorf("dst not overwritten cleanly: %q %v", data, err)
	}
	if _, err := os.Stat(src); !os.IsNotExist(err) {
		t.Errorf("src still exists after overwrite move: %v", err)
	}
}

// detectFormat must route legacy .xls/.xlt to their own category so the user
// gets the targeted "save as .xlsx" error, not the generic "unknown".
func TestDetectFormatLegacyXls(t *testing.T) {
	for _, p := range []string{"a.xls", "a.XLS", "dir/b.xlt"} {
		if got := detectFormat(p); got != "xls-legacy" {
			t.Errorf("detectFormat(%q) = %q, want xls-legacy", p, got)
		}
	}
	// The OOXML family must keep routing to "xlsx" (endsWith safety: ".xlsm"
	// is not ".xls").
	for _, p := range []string{"a.xlsx", "a.xlsm", "a.xltx"} {
		if got := detectFormat(p); got != "xlsx" {
			t.Errorf("detectFormat(%q) = %q, want xlsx", p, got)
		}
	}
}

// cmdCompress on a legacy .xls must fail with the targeted message AND leave
// no output file behind (the generic path used to create none, but the error
// cleanup must not regress that).
func TestCmdCompressLegacyXlsLeavesNoOutput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "legacy.xls")
	if err := os.WriteFile(input, make([]byte, 512), 0o644); err != nil {
		t.Fatal(err)
	}
	res := cmdCompress(input, "default", "medium", 0)
	if res.Error == "" {
		t.Fatal("expected an error for legacy .xls")
	}
	if _, err := os.Stat(res.OutputPath); !os.IsNotExist(err) {
		t.Errorf("output file exists after failed legacy .xls compress: %v", err)
	}
	// No .tmp orphan either.
	if _, err := os.Stat(res.OutputPath + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("tmp orphan left after failed legacy .xls compress: %v", err)
	}
}

// 2026-10-24 用户要求「TMP 文件不要保存、不要生成」：正常路径（成功/回退/
// 失败）的零残留由上面各测试 + 四场景实测覆盖；最后一块是上次进程被强杀
// 遗留的 stale tmp —— tmp 命名确定性（OutputPath + ".tmp"）使下次压缩同一
// 文件时可以自清。输入用假 xlsx：压缩本身必失败，但清扫发生在格式路由
// 之前，与成败无关，正好隔离验证。
func TestCmdCompressSweepsStaleTmpFromKilledRun(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "stale.xlsx")
	if err := os.WriteFile(input, []byte("not a zip at all"), 0o644); err != nil {
		t.Fatal(err)
	}
	stale := filepath.Join(dir, "stale_compressed.xlsx.tmp")
	if err := os.WriteFile(stale, []byte("orphan from a killed run"), 0o644); err != nil {
		t.Fatal(err)
	}
	res := cmdCompress(input, "default", "medium", 0)
	if res.Error == "" {
		t.Fatal("expected the fake xlsx to fail compression")
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Errorf("stale tmp survived cmdCompress: %v", err)
	}
	// 失败路径同样不许留下新的 tmp。
	if _, err := os.Stat(res.OutputPath + ".tmp"); !os.IsNotExist(err) {
		t.Errorf("tmp orphan left after failed compress: %v", err)
	}
}
