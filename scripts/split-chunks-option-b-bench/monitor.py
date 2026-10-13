import ctypes,json,os,subprocess,sys,time
from pathlib import Path
out=Path(sys.argv[1]);cmd=sys.argv[3:]
p=subprocess.Popen(cmd)
handle=None
if sys.platform=='win32':
 from ctypes import wintypes
 class Counters(ctypes.Structure):
  _fields_=[('cb',wintypes.DWORD),('PageFaultCount',wintypes.DWORD)]+[(name,ctypes.c_size_t) for name in ('PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage','PrivateUsage')]
 kernel=ctypes.WinDLL('kernel32',use_last_error=True);psapi=ctypes.WinDLL('psapi',use_last_error=True)
 kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
 psapi.GetProcessMemoryInfo.argtypes=[wintypes.HANDLE,ctypes.POINTER(Counters),wintypes.DWORD]
 kernel.CloseHandle.argtypes=[wintypes.HANDLE]
 handle=kernel.OpenProcess(0x410,False,p.pid)
 if not handle:raise ctypes.WinError(ctypes.get_last_error())
def memory():
 if sys.platform=='linux':
  try:
   for line in Path(f'/proc/{p.pid}/status').read_text().splitlines():
    if line.startswith('RssAnon:'):return int(line.split()[1])*1024
  except OSError:return None
 else:
  c=Counters();c.cb=ctypes.sizeof(c)
  if psapi.GetProcessMemoryInfo(handle,ctypes.byref(c),c.cb):return c.PrivateUsage
 return None
peak=0;count=0;last=None
request=Path(str(out)+'.memory-request');response=Path(str(out)+'.memory-response')
while p.poll() is None:
 value=memory()
 if value is not None:peak=max(peak,value);last=value;count+=1
 if request.exists():
  if value is None:raise RuntimeError('Checkpoint read failed')
  request.unlink();temporary=Path(str(response)+'.new');temporary.write_text(json.dumps({'steadyBytes':value,'peakBytes':peak}));temporary.replace(response)
 time.sleep(.02)
rc=p.wait()
if handle:kernel.CloseHandle(handle)
Path(str(out)+'.memory.json').write_text(json.dumps({'metric':'RssAnon' if sys.platform=='linux' else 'PrivateUsage','peakBytes':peak,'lastBytes':last,'samples':count,'intervalMs':20,'returncode':rc},indent=2)+'\n')
raise SystemExit(rc)
