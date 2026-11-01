#!/bin/sh
# Volumes montados chegam como root; ajusta o dono e roda sem privilégios.
chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null
exec su-exec node "$@"
