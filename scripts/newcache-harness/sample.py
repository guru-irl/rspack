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
    def sample():
        if handle:
            value = Counters(); value.cb = ctypes.sizeof(value)
            if not api.GetProcessMemoryInfo(handle, ctypes.byref(value), value.cb):
                raise ctypes.WinError(ctypes.get_last_error())
            return dict(private_bytes=value.PrivateUsage, peak_commit=value.PeakPagefileUsage, working_set=value.WorkingSetSize, peak_working_set=value.PeakWorkingSetSize)
        if sys.platform.startswith('linux'):
            text = pathlib.Path(f'/proc/{process.pid}/status').read_text()
            return {k: int(v.split()[0])*1024 for k,v in (l.split(':',1) for l in text.splitlines()) if k in ['RssAnon','VmHWM','VmRSS','RssFile']}
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
    anchor_names = []
    with output.with_suffix('.log').open('w') as log:
        for line in process.stdout:
            log.write(line); log.flush()
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if event.get('marker') and event['marker'] != 'complete':
                anchor_names.append(event['marker'])
                markers[event['marker']] = sample()
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
    result['sampled_peak'] = {k:max(s.get(k,0) for s in samples) for k in samples[0] if k != 'at'} if samples else {}
    output.write_text(json.dumps(result))
    return result
