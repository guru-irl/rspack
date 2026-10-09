#!/usr/bin/env bash
set -euo pipefail
mkdir -p results
if [[ "${1:-}" == setup ]]; then
  {
    printf 'ImageOS=%s ImageVersion=%s\n' "${ImageOS:-unknown}" "${ImageVersion:-unknown}"
    uname -a
    lscpu
    free -b
    node --version
    pnpm --version
    df -h
    cat /proc/mounts
    cat /proc/meminfo
  } > results/environment.txt
  if ! sudo modprobe dm-delay > results/modprobe.txt 2>&1; then
    sudo apt-get update > results/modules-install.txt 2>&1 || true
    sudo apt-get install -y "linux-modules-extra-$(uname -r)" >> results/modules-install.txt 2>&1 || true
    if ! sudo modprobe dm-delay >> results/modprobe.txt 2>&1; then
      sudo dmsetup targets > results/dm-targets.txt 2>&1 || true
      cat results/modprobe.txt results/modules-install.txt results/dm-targets.txt
      exit 1
    fi
  fi
  sudo dmsetup targets > results/dm-targets.txt 2>&1
  if ! grep -q '^delay[[:space:]]' results/dm-targets.txt; then
    cat results/modprobe.txt results/dm-targets.txt
    exit 1
  fi
  truncate -s 14G slow-image.bin
  loop_device="$(sudo losetup --find --show --direct-io=on slow-image.bin)"
  printf '%s\n' "$loop_device" > results/loop-device.txt
  sudo losetup -l "$loop_device" > results/loop.txt
  test "$(sudo losetup -n -O DIO "$loop_device" | tr -d ' ')" = 1
  sectors="$(sudo blockdev --getsz "$loop_device")"
  printf '%s\n' "$sectors" > results/sectors.txt
  sudo dmsetup create slow --table "0 ${sectors} delay ${loop_device} 0 0 ${loop_device} 0 0"
  readlink -f /dev/mapper/slow > results/mapper-device.txt
  sudo dmsetup table slow > results/dm-table-0.txt
  sudo mkfs.ext4 -F /dev/mapper/slow > results/mkfs.txt 2>&1
  sudo mount -o data=ordered /dev/mapper/slow slow-mount
  sudo chown "$(id -u):$(id -g)" slow-mount
  findmnt -T slow-mount -o SOURCE,FSTYPE,OPTIONS > results/mount.txt
elif [[ "${1:-}" == cleanup ]]; then
  df -h > results/final-disk.txt
  sudo losetup -l > results/final-loop.txt
  sudo dmsetup table > results/final-dm-table.txt 2>&1 || true
  if mountpoint -q slow-mount; then sudo umount slow-mount; fi
  if [[ -e /dev/mapper/slow ]]; then sudo dmsetup remove slow; fi
  if [[ -f results/loop-device.txt ]]; then sudo losetup -d "$(< results/loop-device.txt)"; fi
else
  echo 'usage: device.sh setup|cleanup' >&2
  exit 2
fi
