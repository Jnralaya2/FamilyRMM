#!/bin/sh
set -eu

printf '%s\n' 'This legacy upgrade entry point is disabled. It cannot create or validate the required recovery set.' >&2
printf '%s\n' 'Do not extract a release archive into /opt/family-rmm. Use scripts/deploy-live.ps1, which invokes deploy/deploy-release.sh and backs up before replacing application files.' >&2
exit 1
