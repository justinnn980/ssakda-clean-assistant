#!/bin/zsh
# 바탕화면에 "싹다클린 AI 비서" 실행 아이콘을 만든다. 프로젝트 폴더를 옮겼으면 다시 실행한다.
# 중간에 하나라도 실패하면 바로 멈춘다
set -e
# 프로그램 폴더의 위치 (이 파일이 있는 scripts 폴더의 한 칸 위)
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 아이콘의 원본(launcher.applescript)에 프로그램 폴더 위치를 채워 넣은 임시 파일을 만든다
TMP="$(mktemp -t launcher).applescript"
sed "s|__APP_DIR__|$APP_DIR|" "$APP_DIR/scripts/launcher.applescript" > "$TMP"
# 그 임시 파일을 바탕화면의 앱(아이콘)으로 만들고, 임시 파일은 지운다
osacompile -o "$HOME/Desktop/싹다클린 AI 비서.app" "$TMP"
rm -f "$TMP"
echo "바탕화면에 '싹다클린 AI 비서' 아이콘을 만들었습니다."
