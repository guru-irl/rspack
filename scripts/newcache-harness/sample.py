import ctypes
import json
import os
import pathlib
import subprocess
import sys
import threading
import time

# Windows PROCESS_MEMORY_COUNTERS_EX exposes current and lifetime commit/RSS,
# unlike psutil's platform-dependent private-byte aliases.
class Counters(ctypes.Structure):
    _fields_ = [('cb', ctypes.c_ulong), ('PageFaultCount', ctypes.c_ulong)] + [(n, ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage']]

class RusageV4(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_ubyte*16)] + [(n, ctypes.c_uint64) for n in [
        'user_time','system_time','pkg_idle_wkups','interrupt_wkups','pageins','wired_size','resident_size','phys_footprint','proc_start_abstime','proc_exit_abstime','child_user_time','child_system_time','child_pkg_idle_wkups','child_interrupt_wkups','child_pageins','child_elapsed_abstime','diskio_bytesread','diskio_byteswritten','cpu_time_qos_default','cpu_time_qos_maintenance','cpu_time_qos_background','cpu_time_qos_utility','cpu_time_qos_legacy','cpu_time_qos_user_initiated','cpu_time_qos_user_interactive','billed_system_time','serviced_system_time','logical_writes','lifetime_max_phys_footprint','instructions','cycles','billed_energy','serviced_energy','interval_max_phys_footprint','runnable_time']]

def measure(command, output, env):
    process = subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    samples = []
    handle = None
    if sys.platform == 'win32':
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_bool, ctypes.c_ulong]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        api = ctypes.WinDLL('psapi', use_last_error=True)
        api.GetProcessMemoryInfo.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_ulong]
        handle = kernel.OpenProcess(0x410, False, process.pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
    if sys.platform == 'darwin':
        libproc=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
        libproc.proc_pid_rusage.argtypes=[ctypes.c_int,ctypes.c_int,ctypes.c_void_p]
        libproc.proc_pid_rusage.restype=ctypes.c_int
    def sample():
        if handle:
            value = Counters(); value.cb = ctypes.sizeof(value)
            if not api.GetProcessMemoryInfo(handle, ctypes.byref(value), value.cb):
                raise ctypes.WinError(ctypes.get_last_error())
            return dict(private_bytes=value.PrivateUsage, peak_commit=value.PeakPagefileUsage, working_set=value.WorkingSetSize, peak_working_set=value.PeakWorkingSetSize)
        if sys.platform.startswith('linux'):
            text = pathlib.Path(f'/proc/{process.pid}/status').read_text()
            return {k: int(v.split()[0])*1024 for k,v in (l.split(':',1) for l in text.splitlines()) if k in ['RssAnon','VmHWM','VmRSS','RssFile']}
        if sys.platform == 'darwin':
            value=RusageV4()
            if libproc.proc_pid_rusage(process.pid,4,ctypes.byref(value)): raise OSError(ctypes.get_errno(),'proc_pid_rusage failed')
            return dict(phys_footprint=value.phys_footprint,peak_phys_footprint=value.lifetime_max_phys_footprint)
        return {}
    stop = threading.Event()
    errors = []
    def loop():
        while not stop.wait(0.05):
            try:
                m = sample()
                if m: samples.append(dict(at=time.monotonic(), **m))
            except (FileNotFoundError, ProcessLookupError):
                break
            except Exception as e:
                errors.append(str(e)); break
    thread = threading.Thread(target=loop); thread.start()
    markers = {}
    marker_times = {}
    event_times = {}
    anchor_names = []
    with output.with_suffix('.log').open('w') as log:
        for line in process.stdout:
            log.write(line); log.flush()
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('marker_event'):
                event_times[event['marker_event']]=time.monotonic()
            if event.get('marker') and event['marker'] != 'complete':
                marker_times[event['marker']]=time.monotonic()
                anchor_names.append(event['marker'])
                markers[event['marker']] = sample()
                if markers[event['marker']]:samples.append(dict(at=marker_times[event['marker']],**markers[event['marker']]))
                process.stdin.write('ack\n'); process.stdin.flush()
    rc = process.wait(); stop.set(); thread.join()
    if handle: kernel.CloseHandle(handle)
    output.with_suffix('.timeline.json').write_text(json.dumps(samples))
    if len(anchor_names) != len(set(anchor_names)) or not anchor_names or anchor_names[-1] != 'post_close': raise RuntimeError(f'Missing or duplicate anchors: {anchor_names}')
    if rc: raise RuntimeError(f'Command failed with exit {rc}: {command}')
    if errors: raise RuntimeError(f'Memory sampler failed: {errors}')
    result = json.loads(output.read_text())
    if sys.platform == 'win32':
        for anchor in result['anchors']:
            m = markers.get(anchor['name'])
            if not m: raise RuntimeError('Missing Windows memory counter')
            anchor['memory'] = m
    if result['phase']=='watch':
        done=next(a for a in result['anchors'] if a['name']=='done')
        fixed=[]
        for offset in result['checkpoints_ms']:
            target=marker_times['done']+offset/1000
            selected=min(samples,key=lambda s:abs(s['at']-target))
            actual=(selected['at']-marker_times['done'])*1000
            fixed.append(dict(name=f'post_done_{offset}ms',wall_ms=done['wall_ms']+actual,memory={k:v for k,v in selected.items() if k!='at'},actual_after_done_ms=actual,nearest_sample_error_ms=actual-offset,requested_after_done_ms=offset,source='external_timeline'))
        result['anchors'][1:1]=fixed
        if 'edit_start' not in event_times:raise RuntimeError('Missing edit-start event')
        edit_samples=[s for s in samples if event_times['edit_start']<=s['at']<=marker_times['rebuild_done']]
        if not edit_samples:raise RuntimeError('Missing rebuild timeline')
        result['rebuild_sampled_peak']={k:max(s[k] for s in edit_samples) for k in edit_samples[0] if k!='at'}
    result['sampled_peak'] = {k:max(s.get(k,0) for s in samples) for k in samples[0] if k != 'at'} if samples else {}
    output.write_text(json.dumps(result))
    return result
