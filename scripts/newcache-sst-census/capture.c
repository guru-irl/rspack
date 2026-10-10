#define _GNU_SOURCE
#include <dlfcn.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int rename(const char *oldpath, const char *newpath) {
  static int (*real_rename)(const char *, const char *);
  if (!real_rename) real_rename = dlsym(RTLD_NEXT, "rename");
  int result = real_rename(oldpath, newpath);
  const char *marker = getenv("SST_CAPTURE_MARKER");
  size_t n = strlen(newpath);
  if (result == 0 && marker && n >= 8 && strcmp(newpath + n - 8, "/CURRENT") == 0) {
    unsigned char seq[4];
    int current = open(newpath, O_RDONLY);
    ssize_t count = current >= 0 ? read(current, seq, 4) : -1;
    if (current >= 0) close(current);
    if (count == 4 && (seq[0] || seq[1] || seq[2] || seq[3])) {
      int fd = open(marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
      if (fd >= 0) {
        dprintf(fd, "%d\n%s\n", getpid(), newpath);
        close(fd);
        kill(getpid(), SIGSTOP);
      }
    }
  }
  return result;
}
