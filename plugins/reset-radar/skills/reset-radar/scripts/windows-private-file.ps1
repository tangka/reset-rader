# Static Windows PowerShell 5.1 / .NET Framework helper. No caller data is code.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

try {
    . ([System.IO.Path]::Combine($PSScriptRoot, 'windows-private-file-library.ps1'))

    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 524288) { throw 'Invalid request.' }
    $request = ConvertFrom-Json -InputObject $inputText -ErrorAction Stop
    if ($request.path -isnot [string]) { throw 'Invalid request.' }
    if ($request.operation -eq 'read') {
        $content = [RadarPrivateFile]::Read($request.path)
        [Console]::Out.Write((ConvertTo-Json -InputObject @{ok = $true; content = $content} -Compress))
    } elseif ($request.operation -eq 'write' -and $request.content -is [string]) {
        [RadarPrivateFile]::Write($request.path, $request.content)
        [Console]::Out.Write('{"ok":true}')
    } else { throw 'Invalid request.' }
} catch {
    $failure = $_.Exception.GetBaseException()
    $missing = ($failure -is [System.ComponentModel.Win32Exception] -and
        ($failure.NativeErrorCode -eq 2 -or $failure.NativeErrorCode -eq 3)) -or
        $failure -is [System.IO.FileNotFoundException] -or $failure -is [System.IO.DirectoryNotFoundException]
    if ($missing) { [Console]::Out.Write('{"ok":false,"code":"ENOENT"}') }
    else { [Console]::Out.Write('{"ok":false,"code":"EPRIVATE"}') }
}
