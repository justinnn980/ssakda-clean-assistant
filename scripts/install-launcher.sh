#!/bin/zsh
# 바탕화면에 "싹다클린 AI 비서" 실행 아이콘을 만든다. 프로젝트 폴더를 옮겼으면 다시 실행한다.
set -e
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -t launcher).applescript"
sed "s|__APP_DIR__|$APP_DIR|" "$APP_DIR/scripts/launcher.applescript" > "$TMP"
osacompile -o "$HOME/Desktop/싹다클린 AI 비서.app" "$TMP"
rm -f "$TMP"
echo "바탕화면에 '싹다클린 AI 비서' 아이콘을 만들었습니다."
