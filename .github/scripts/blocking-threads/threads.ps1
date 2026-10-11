param([int]$TargetPid, [string]$OutFile)
$writer = [System.IO.StreamWriter]::new($OutFile, $false)
$writer.AutoFlush = $true
try {
  while ($true) {
    try { $p = Get-Process -Id $TargetPid -ErrorAction Stop } catch { break }
    $writer.WriteLine((@{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); threads=$p.Threads.Count} | ConvertTo-Json -Compress))
    Start-Sleep -Milliseconds 100
  }
} finally { $writer.Dispose() }
