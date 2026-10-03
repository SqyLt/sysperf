#!/usr/bin/env bash
# SysPerf 启动脚本
cd "$(dirname "$(readlink -f "$0")")"
export DISPLAY="${DISPLAY:-:1}"
exec ./node_modules/.bin/electron . --no-sandbox "$@"
