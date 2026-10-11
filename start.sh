#!/bin/zsh
# 싹다클린 AI 비서 실행. 켜져 있는 동안 노트북이 잠들지 않게 한다.
cd "$(dirname "$0")"
# 아이콘으로 켜면 사용자 이름이 비어 있을 수 있는데, 그러면 AI 로그인 정보를 읽지 못한다
export USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
mkdir -p data
exec caffeinate -is node server.js
