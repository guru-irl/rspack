#!/bin/sh
# Run a command in a private user namespace whose inotify watch limit is $NSLIMIT. The system limit is unchanged.
exec unshare -U -r sh -c 'echo "$NSLIMIT" > /proc/sys/user/max_inotify_watches && echo "nslimit=$(cat /proc/sys/user/max_inotify_watches)" >&2 && exec "$@"' sh "$@"
