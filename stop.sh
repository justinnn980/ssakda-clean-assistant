#!/bin/zsh
# 싹다클린 AI 비서 종료.
cd "$(dirname "$0")"
[ -f data/server.pid ] && kill "$(cat data/server.pid)" 2>/dev/null
exit 0
