#!/bin/bash

# Domi 图标生成脚本
# 所有入口使用轻 3D 版，同时保留小尺寸简化资源以便回退
# 依赖：rsvg-convert (librsvg)、iconutil (macOS)、magick (ImageMagick)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "🎨 Generating Domi icons..."

# Check required tools
if ! command -v rsvg-convert &> /dev/null; then
    echo "❌ rsvg-convert not found. Install with: brew install librsvg"
    exit 1
fi

if ! command -v magick &> /dev/null; then
    echo "❌ ImageMagick (magick) not found. Install with: brew install imagemagick"
    exit 1
fi

if ! command -v iconutil &> /dev/null; then
    echo "⚠️  iconutil not found (macOS only). Skipping .icns generation"
fi

# 1. 生成正式轻 3D 资源，并保留同轮廓无特效备份。
echo "📦 Generating responsive PNG assets..."
rsvg-convert -w 1024 -h 1024 icon.svg -o icon-source.png
cp icon-source.png icon.png
rsvg-convert -w 1024 -h 1024 icon-small.svg -o icon-small.png
rsvg-convert -w 256 -h 256 icon-small.svg -o ../src/renderer/assets/brand/domi-mark-small.png
rsvg-convert -w 256 -h 256 icon.svg -o ../src/renderer/assets/brand/domi-mark.png
ACTIVE_ICON="icon.png"

# 2. Generate menubar/tray icons (multi-resolution for Retina displays)
echo "📦 Generating tray icons..."

# macOS 托盘图标规范：
# - 标准尺寸: 22x22pt（点）
# - @2x Retina: 44x44px
# - @3x 高分辨率: 66x66px
# 使用 "Template" 命名让 macOS 自动适配深色/浅色菜单栏
TRAY_SVG="icon.svg"

if [ ! -f "$TRAY_SVG" ]; then
  echo "⚠️  Tray icon SVG not found at $TRAY_SVG, skipping tray icon generation"
else
  # 生成多分辨率 Template 图标（macOS 会自动选择合适的版本）
  rsvg-convert -w 22 -h 22 "$TRAY_SVG" -o domi-logos/iconTemplate.png
  rsvg-convert -w 44 -h 44 "$TRAY_SVG" -o "domi-logos/iconTemplate@2x.png"
  rsvg-convert -w 66 -h 66 "$TRAY_SVG" -o "domi-logos/iconTemplate@3x.png"

  echo "✅ Tray icons generated:"
  echo "   - domi-logos/iconTemplate.png (22x22 @1x)"
  echo "   - domi-logos/iconTemplate@2x.png (44x44 @2x Retina)"
  echo "   - domi-logos/iconTemplate@3x.png (66x66 @3x)"
fi

# 3. Generate .icns (macOS app icon)
if command -v iconutil &> /dev/null; then
    echo "📦 Generating icon.icns..."

    # Create iconset directory
    mkdir -p icon.iconset

    # Generate all required sizes for macOS
    # Standard resolutions
    sips -z 16 16     "$ACTIVE_ICON" --out icon.iconset/icon_16x16.png      > /dev/null 2>&1
    sips -z 32 32     "$ACTIVE_ICON" --out icon.iconset/icon_16x16@2x.png   > /dev/null 2>&1
    sips -z 32 32     "$ACTIVE_ICON" --out icon.iconset/icon_32x32.png      > /dev/null 2>&1
    sips -z 64 64     icon.png --out icon.iconset/icon_32x32@2x.png   > /dev/null 2>&1
    sips -z 128 128   icon.png --out icon.iconset/icon_128x128.png    > /dev/null 2>&1
    sips -z 256 256   icon.png --out icon.iconset/icon_128x128@2x.png > /dev/null 2>&1
    sips -z 256 256   icon.png --out icon.iconset/icon_256x256.png    > /dev/null 2>&1
    sips -z 512 512   icon.png --out icon.iconset/icon_256x256@2x.png > /dev/null 2>&1
    sips -z 512 512   icon.png --out icon.iconset/icon_512x512.png    > /dev/null 2>&1
    sips -z 1024 1024 icon.png --out icon.iconset/icon_512x512@2x.png > /dev/null 2>&1

    # Convert to .icns
    iconutil -c icns icon.iconset -o icon.icns

    # Clean up
    rm -rf icon.iconset

    echo "✅ icon.icns generated"
else
    echo "⚠️  Skipping .icns generation (iconutil not available)"
fi

# 4. Generate .ico (Windows app icon)
echo "📦 Generating icon.ico..."
# Windows 的任务栏图标槽会增加额外留白，因此仅对 ICO 做 8% 横向光学校正。
# 所有尺寸先试用轻 3D 源；无特效资源继续保留，未删除。
WINDOWS_ICON_DIR="$(mktemp -d)"
trap 'rm -rf "$WINDOWS_ICON_DIR"' EXIT
magick "$ACTIVE_ICON" -resize 1106x1024\! -gravity center -extent 1024x1024 "$WINDOWS_ICON_DIR/active.png"
for size in 16 32 48 64 96 128 256; do
  magick "$WINDOWS_ICON_DIR/active.png" -resize "${size}x${size}" "$WINDOWS_ICON_DIR/icon-${size}.png"
done
magick "$WINDOWS_ICON_DIR/icon-16.png" "$WINDOWS_ICON_DIR/icon-32.png" \
  "$WINDOWS_ICON_DIR/icon-48.png" "$WINDOWS_ICON_DIR/icon-64.png" \
  "$WINDOWS_ICON_DIR/icon-96.png" "$WINDOWS_ICON_DIR/icon-128.png" \
  "$WINDOWS_ICON_DIR/icon-256.png" icon.ico
rm -rf "$WINDOWS_ICON_DIR"
trap - EXIT
echo "✅ icon.ico generated"

echo ""
echo "✅ All icons generated successfully!"
echo ""
echo "Generated files:"
echo "  - icon.png (1024x1024) - Linux & macOS Dock"
echo "  - icon.icns - macOS app icon"
echo "  - icon.ico - Windows app icon"
echo "  - domi-logos/iconTemplate.png - macOS tray (22x22 @1x)"
echo "  - domi-logos/iconTemplate@2x.png - macOS tray (44x44 @2x Retina)"
echo "  - domi-logos/iconTemplate@3x.png - macOS tray (66x66 @3x)"
