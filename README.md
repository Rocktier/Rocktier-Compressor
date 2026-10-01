# Rocktier Compressor (CO)

Offline document and image compressor. Shrink PDFs, Office docs, and images on your own machine — no uploads, no accounts. Privacy-first: everything runs locally.

## Tech Stack

| Layer | Choice |
|-------|--------|
| Desktop | Tauri v2 (Rust) + React + TypeScript + Vite |
| Compression Engine | Go (static binary embedded) |
| PDF | pdfcpu (Apache-2.0) |
| OOXML | Custom `archive/zip` repackage + embedded-media resampling |
| Images | Go `image/*` stdlib + `golang.org/x/image` (BSD-3) |

See `THIRD-PARTY-NOTICES.md` for full license attributions.

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
