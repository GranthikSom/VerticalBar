#!/bin/bash
APP_NAME="$1"
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
OUT_DIR="$DIR/icons"
OUT_FILE="$OUT_DIR/$APP_NAME.png"

# Don't regenerate if it exists
[ -f "$OUT_FILE" ] && exit 0

mkdir -p "$OUT_DIR"

# ponytail: lsappinfo resolves running app display name → actual bundle path.
# This fixes apps where process name != bundle name (e.g. "Code" → "Visual Studio Code.app")
APP_PATH=$(lsappinfo info -only bundlepath "$APP_NAME" 2>/dev/null | sed -n 's/.*"\(\/.*\.app\)".*/\1/p')

# Fallback: mdfind by bundle name
if [ -z "$APP_PATH" ]; then
  APP_PATH=$(mdfind "kMDItemKind == 'Application' && kMDItemFSName == '${APP_NAME}.app'" | head -n 1)
fi

# Fallback: common filesystem paths
if [ -z "$APP_PATH" ]; then
  if [ -d "/Applications/${APP_NAME}.app" ]; then APP_PATH="/Applications/${APP_NAME}.app"
  elif [ -d "/System/Applications/${APP_NAME}.app" ]; then APP_PATH="/System/Applications/${APP_NAME}.app"
  elif [ -d "/System/Applications/Utilities/${APP_NAME}.app" ]; then APP_PATH="/System/Applications/Utilities/${APP_NAME}.app"
  fi
fi

if [ -n "$APP_PATH" ]; then
  ICON_FILE=$(defaults read "$APP_PATH/Contents/Info.plist" CFBundleIconFile 2>/dev/null)
  if [ -n "$ICON_FILE" ]; then
    [[ "$ICON_FILE" != *.icns ]] && ICON_FILE="${ICON_FILE}.icns"
    ICON_PATH="$APP_PATH/Contents/Resources/$ICON_FILE"
    
    if [ -f "$ICON_PATH" ]; then
      sips -s format png -z 64 64 "$ICON_PATH" --out "$OUT_FILE" >/dev/null 2>&1
      exit 0
    fi
  fi
  # Fallback to AppIcon.icns if plist fails
  if [ -f "$APP_PATH/Contents/Resources/AppIcon.icns" ]; then
    sips -s format png -z 64 64 "$APP_PATH/Contents/Resources/AppIcon.icns" --out "$OUT_FILE" >/dev/null 2>&1
    exit 0
  fi
fi

# If all fails, copy fallback
cp "$OUT_DIR/fallback.png" "$OUT_FILE"
