#include <node_api.h>
#include <libproc.h>
#include <sys/resource.h>
#include <unistd.h>

static void number(napi_env env, napi_value object, const char *key, uint64_t n) {
  napi_value value;
  napi_create_double(env, (double)n, &value);
  napi_set_named_property(env, object, key, value);
}
static napi_value sample(napi_env env, napi_callback_info info) {
  (void)info;
  struct rusage_info_v4 usage = {0};
  if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&usage) != 0) {
    napi_throw_error(env, NULL, "proc_pid_rusage(RUSAGE_INFO_V4) failed");
    return NULL;
  }
  napi_value result;
  napi_create_object(env, &result);
  number(env, result, "phys_footprint", usage.ri_phys_footprint);
  number(env, result, "peak", usage.ri_lifetime_max_phys_footprint);
  number(env, result, "resident_size", usage.ri_resident_size);
  number(env, result, "kernel_user_ns", usage.ri_user_time);
  number(env, result, "kernel_system_ns", usage.ri_system_time);
  return result;
}
NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "sample", NAPI_AUTO_LENGTH, sample, NULL, &fn);
  napi_set_named_property(env, exports, "sample", fn);
  return exports;
}
