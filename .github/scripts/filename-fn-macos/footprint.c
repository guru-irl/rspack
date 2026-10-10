#include <node_api.h>
#include <mach/mach.h>
#include <mach/task_info.h>
#include <stddef.h>
static void number(napi_env env, napi_value obj, const char *key, uint64_t value) {
  napi_value x; napi_create_double(env, (double)value, &x); napi_set_named_property(env, obj, key, x);
}
static napi_value snapshot(napi_env env, napi_callback_info ignored) {
  task_vm_info_data_t vm = {0}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
  kern_return_t rc = task_info(mach_task_self(), TASK_VM_INFO, (task_info_t)&vm, &count);
  if (rc != KERN_SUCCESS || count * sizeof(natural_t) < offsetof(task_vm_info_data_t, ledger_phys_footprint_peak) + sizeof(vm.ledger_phys_footprint_peak)) {
    napi_throw_error(env, NULL, "Mach TASK_VM_INFO footprint/peak ledger unavailable"); return NULL;
  }
  napi_value obj; napi_create_object(env, &obj);
  number(env, obj, "physFootprint", vm.phys_footprint);
  number(env, obj, "peakPhysFootprint", vm.ledger_phys_footprint_peak);
  number(env, obj, "residentSize", vm.resident_size);
  number(env, obj, "compressed", vm.compressed);
  return obj;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value fn; napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, snapshot, NULL, &fn);
  napi_set_named_property(env, exports, "snapshot", fn); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
