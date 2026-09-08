[Console]::Out.WriteLine('BOOT')
$joined = Join-Path $PSScriptRoot 'probe'
[Console]::Out.WriteLine('PATH')
$value = ConvertTo-Json -InputObject @{ok = $true} -Compress
[Console]::Out.WriteLine('JSON')
Add-Type -TypeDefinition 'public static class RadarStartupProbe { public static int Value = 1; }'
[Console]::Out.WriteLine('COMPILED')
