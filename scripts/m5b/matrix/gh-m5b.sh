#!/bin/sh
# gh for the matrix services.
#
# The wrapper pins HOME and GH_CONFIG_DIR because the caller may scrub the
# environment (no HOME means gh would fall back to /root or to the invoker's
# home). It points at the dedicated, probe-only configuration, never at the
# shared /root/.config/gh-agent token used by the host bootstrap.
#
# Overrides exist for a differently laid out host; the defaults match
# scripts/m5b/matrix/lib.sh.
HOME=${M5B_MATRIX_GH_HOME:-/home/m5bmatrix}
GH_CONFIG_DIR=${M5B_MATRIX_GH_CONFIG_DIR:-/root/.config/m5bmatrix/gh}
export HOME GH_CONFIG_DIR
exec gh "$@"
