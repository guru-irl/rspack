#include <node_api.h>
#include <mach/mach.h>
#include <mach/task_info.h>

static void number(napi_env env, napi_value object, const char *key, uint64_t n) {
  napi_value value;
  napi_create_double(env, (double)n, &value);
  napi_set_named_property(env, object, key, value);
}
static napi_value sample(napi_env env, napi_callback_info info) {
  task_vm_info_data_t vm = {0};
  mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  kern_return_t rc = task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&vm, &count);
  if (rc != KERN_SUCCESS || count < TASK_VM_INFO_REV3_COUNT) {
    napi_throw_error(env, NULL, "task_vm_info footprint/peak unavailable");
    return NULL;
  }
  napi_value result;
  napi_create_object(env, &result);
  number(env, result, "phys_footprint", vm.phys_footprint);
  number(env, result, "peak_phys_footprint", vm.ledger_phys_footprint_peak);
  return result;
}
NAPI_MODULE_INIT() {
  napi_value fn;
  napi_create_function(env, "sample", NAPI_AUTO_LENGTH, sample, NULL, &fn);
  napi_set_named_property(env, exports, "sample", fn);
  return exports;
}
