#!/bin/sh
set -eu
umask 077

if [ -n "${COLIMA_HOME:-}" ]; then
  printf '%s\n' 'Unset COLIMA_HOME first: this project uses ~/.colima/config-v.' >&2
  exit 1
fi

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
profile_dir="${HOME}/.colima/config-v"
mkdir -p "${HOME}/.colima"
if ! mkdir "$profile_dir"; then
  printf '%s\n' 'Existing config-v profile left unchanged. Review its mounts and forwarding settings manually.' >&2
  exit 1
fi
cp "$project_dir/infra/colima/config-v.yaml" "$profile_dir/colima.yaml"
printf '%s\n' 'Created ~/.colima/config-v/colima.yaml. No VM was started and no software was installed.'
printf '%s\n' 'Review it, then start explicitly: colima start --profile config-v'
