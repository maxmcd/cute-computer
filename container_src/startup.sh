#!/bin/sh
set -ex
mkdir -p /mnt/r2
/usr/local/bin/tigrisfs --endpoint "http://host.docker.internal:8787" -f "foo" /mnt/r2 &
sleep 3
ls -lah /mnt/r2

/server
