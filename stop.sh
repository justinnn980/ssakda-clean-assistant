#!/bin/zsh
# 싹다클린 AI 비서 종료.
# 이 파일이 있는 폴더(프로그램 폴더)로 간다
cd "$(dirname "$0")"
# 서버가 켜질 때 적어 둔 프로세스 번호를 읽어 그 프로그램에 끄라는 신호를 보낸다. 꺼져 있어도 오류로 치지 않는다
[ -f data/server.pid ] && kill "$(cat data/server.pid)" 2>/dev/null
exit 0
