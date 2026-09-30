# Rocktier Compressor (CO)

Offline document and image compressor. Shrink PDFs, Office docs, and images without losing quality. Privacy-first: everything runs on your machine, not someone else's server.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Desktop | Tauri v2 (Rust) + React + TypeScript + Vite |
| Compression Engine | Go (static binary embedded) |
| PDF | pdfcpu (Apache-2.0) |
| OOXML | Custom `archive/zip` + `encoding/xml` |
| XLSX | excelize (BSD-3) |
| Images | Go `image/*` standard library |

## Pricing

$9.99 standalone · $19.99 Rocktier family bundle.

## Building

```bash
# Install deps
npm install

# Build Go engine for current platform (CI cross-compiles all)
cd compress-engine && go build -o ../src-tauri/compress-engine-windows.exe .  # Windows
cd compress-engine && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o ../src-tauri/compress-engine-macos .  # macOS

# Dev
npm run tauri dev

# Build installer (Windows)
npm run tauri build
```

## Development

The project is structured for GitHub Actions CI — no local builds required. Tag `v*` triggers automatic builds for Windows and macOS.

## License

Commercial — part of the Rocktier family of creative tools.
