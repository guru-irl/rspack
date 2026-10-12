#include <node_api.h>
#include <libproc.h>
#include <unistd.h>
static void number(napi_env env, napi_value obj, const char *key, uint64_t n) {
  napi_value value; napi_create_double(env, (double)n, &value); napi_set_named_property(env, obj, key, value);
}
static napi_value sample(napi_env env, napi_callback_info info) {
  struct rusage_info_v4 usage = {0};
  if (proc_pid_rusage(getpid(), RUSAGE_INFO_V4, (rusage_info_t *)&usage)) {
    napi_throw_error(env, NULL, "proc_pid_rusage failed"); return NULL;
  }
  napi_value obj; napi_create_object(env, &obj);
  number(env, obj, "phys_footprint", usage.ri_phys_footprint);
  number(env, obj, "peak_phys_footprint", usage.ri_lifetime_max_phys_footprint);
  return obj;
}
NAPI_MODULE_INIT() {
  napi_value fn; napi_create_function(env, "sample", NAPI_AUTO_LENGTH, sample, NULL, &fn);
  napi_set_named_property(env, exports, "sample", fn); return exports;
}
