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
