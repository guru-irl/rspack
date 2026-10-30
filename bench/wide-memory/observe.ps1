param([int]$TargetPid, [string]$Fixture, [switch]$Directories, [switch]$SelfControl)
$ErrorActionPreference = 'Stop'
if ($SelfControl) { $TargetPid = $PID; $Directories = $true }
$p = Get-Process -Id $TargetPid
$row = @{ workingSetBytes = $p.WorkingSet64; peakWorkingSetBytes = $p.PeakWorkingSet64; privateBytes = $p.PrivateMemorySize64; totalHandles = $p.HandleCount }
if ($Directories) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class DirectoryHandles {
 [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr b, int n, out int r);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint a, bool i, int p);
 [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr s, IntPtr h, IntPtr t, out IntPtr d, uint a, bool i, uint o);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr h);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetFileInformationByHandleEx(IntPtr h, int c, IntPtr b, uint n);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr h, StringBuilder b, uint n, uint f);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string p, uint a, uint s, IntPtr x, uint c, uint f, IntPtr t);
 public static void Control(string fixture) {
  IntPtr handle=CreateFile(fixture,1,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
  if(handle.ToInt64()==-1) throw new Exception("Directory control open failed " + Marshal.GetLastWin32Error());
  int pid=System.Diagnostics.Process.GetCurrentProcess().Id;
  try { if(Count(pid,fixture)[0]!=1) throw new Exception("Directory control failed to count one handle"); }
  finally { CloseHandle(handle); }
  if(Count(pid,fixture)[0]!=0) throw new Exception("Directory control counted a closed handle");
 }
 public static long[] Count(int pid, string fixture) {
  if (IntPtr.Size != 8) throw new Exception("x64 handle layout required");
  string root = fixture.TrimEnd('\\').ToLowerInvariant();
  IntPtr proc = OpenProcess(0x40, false, pid);
  if (proc == IntPtr.Zero) throw new Exception("OpenProcess failed");
  IntPtr classifier=CreateFile(System.IO.Path.GetPathRoot(fixture),0,7,IntPtr.Zero,3,0x02000000,IntPtr.Zero);
  if(classifier.ToInt64()==-1) throw new Exception("File-type classifier open failed");
  IntPtr buffer = IntPtr.Zero, info = Marshal.AllocHGlobal(64);
  long allDirectories=0, fixtureDirectories=0, inaccessible=0;
  try {
   int size=1048576, needed, rc;
   while (true) {
    buffer=Marshal.AllocHGlobal(size);
    rc=NtQuerySystemInformation(64, buffer, size, out needed);
    if (rc == 0) break;
    Marshal.FreeHGlobal(buffer); buffer=IntPtr.Zero;
    if (rc != unchecked((int)0xC0000004)) throw new Exception("Handle query status " + rc);
    size=Math.Max(size*2, needed+65536);
    if (size>268435456) throw new Exception("Handle table too large");
   }
   long count=Marshal.ReadInt64(buffer);
   int ownPid=System.Diagnostics.Process.GetCurrentProcess().Id, fileType=-1;
   for(long i=0;i<count;i++) {
    IntPtr entry=new IntPtr(buffer.ToInt64()+16+i*40);
    if(Marshal.ReadInt64(entry,8)==ownPid && Marshal.ReadInt64(entry,16)==classifier.ToInt64()) { fileType=(ushort)Marshal.ReadInt16(entry,30); break; }
   }
   if(fileType<0) throw new Exception("File object type not found");
   for(long i=0;i<count;i++) {
    IntPtr entry=new IntPtr(buffer.ToInt64()+16+i*40);
    if (Marshal.ReadInt64(entry,8)!=pid || (ushort)Marshal.ReadInt16(entry,30)!=fileType) continue;
    IntPtr copy;
    if (!DuplicateHandle(proc, new IntPtr(Marshal.ReadInt64(entry,16)), GetCurrentProcess(), out copy, 0, false, 2)) { inaccessible++; continue; }
    try {
     if (GetFileType(copy)!=1) continue;
     var name=new StringBuilder(32768);
     uint n=GetFinalPathNameByHandle(copy,name,(uint)name.Capacity,0);
     if (n==0 || n>=name.Capacity) { inaccessible++; continue; }
     string value=name.ToString();
     if(value.StartsWith(@"\\?\")) value=value.Substring(4);
     if(!System.IO.Directory.Exists(value)) continue;
     allDirectories++;
     value=value.TrimEnd('\\').ToLowerInvariant();
     if(value==root || value.StartsWith(root+"\\")) fixtureDirectories++;
    } finally { CloseHandle(copy); }
   }
  } finally { if(buffer!=IntPtr.Zero) Marshal.FreeHGlobal(buffer); Marshal.FreeHGlobal(info); CloseHandle(classifier); CloseHandle(proc); }
  return new long[]{fixtureDirectories,allDirectories,inaccessible};
 }
}
'@
 if ($SelfControl) { [DirectoryHandles]::Control($Fixture); $row.directoryControl = 'positive and closed-handle negative passed' }
 $counts = [DirectoryHandles]::Count($TargetPid, $Fixture)
 $row.fixtureDirectoryHandles = $counts[0]
 $row.allDirectoryHandles = $counts[1]
 $row.inaccessibleHandles = $counts[2]
 $row.directoryMethod = 'SystemExtendedHandleInformation/GetFinalPathNameByHandle'
}
$row | ConvertTo-Json -Compress
