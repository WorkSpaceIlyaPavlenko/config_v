#!/bin/sh
set -eu

if [ "$#" -eq 0 ]; then
  printf '%s\n' 'Usage: sh scripts/colima-docker.sh <docker command> [arguments]' >&2
  exit 1
fi
case "$1" in
  -*)
    printf '%s\n' 'Docker global options are not accepted; this wrapper fixes the config-v daemon.' >&2
    exit 1
    ;;
esac
if [ -n "${COLIMA_HOME:-}" ]; then
  printf '%s\n' 'Unset COLIMA_HOME first: this project uses ~/.colima/config-v.' >&2
  exit 1
fi
command -v docker >/dev/null 2>&1 || {
  printf '%s\n' 'Docker CLI is not installed. This script does not install software.' >&2
  exit 1
}
if [ ! -S "${HOME}/.colima/config-v/docker.sock" ]; then
  printf '%s\n' 'The config-v socket is unavailable. Start the reviewed Colima profile explicitly.' >&2
  exit 1
fi

# A named context can override DOCKER_HOST, so remove both ambient selectors.
unset DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY DOCKER_CERT_PATH
exec docker --host "unix://${HOME}/.colima/config-v/docker.sock" "$@"
