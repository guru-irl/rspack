#include <stdint.h>
#include <libproc.h>
#include <sys/resource.h>

int footprint(int pid, uint64_t *current, uint64_t *peak) {
  struct rusage_info_v4 info;
  int result = proc_pid_rusage(pid, RUSAGE_INFO_V4, (rusage_info_t *)&info);
  if (result == 0) {
    *current = info.ri_phys_footprint;
    *peak = info.ri_lifetime_max_phys_footprint;
  }
  return result;
}
