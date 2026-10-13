#!/bin/zsh
# 싹다클린 AI 비서 실행. 켜져 있는 동안 노트북이 잠들지 않게 한다.
# 이 파일이 있는 폴더(프로그램 폴더)로 간다
cd "$(dirname "$0")"
# 아이콘으로 켜면 사용자 이름이 비어 있을 수 있는데, 그러면 AI 로그인 정보를 읽지 못한다
export USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}"
# node, codex, claude 같은 프로그램을 찾을 수 있게 설치 위치들을 실행 경로에 넣는다
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
# nvm으로 Node를 설치한 경우 그 설정을 불러온다
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
# 자료를 둘 data 폴더를 만든다 (이미 있으면 그대로 둔다)
mkdir -p data
# 노트북이 잠들지 않게 한 채로(caffeinate) 서버를 실행한다
exec caffeinate -is node server.js
