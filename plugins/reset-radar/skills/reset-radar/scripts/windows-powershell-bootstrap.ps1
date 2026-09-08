# Use only Windows PowerShell's built-in modules, without scanning user/third-party modules.
# Cold automatic discovery can exceed the private-file operation timeout on a fresh machine.
$PSModuleAutoLoadingPreference = 'None'
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Utility')) {
    $manifest = [System.IO.Path]::Combine($env:PSModulePath, $moduleName, ($moduleName + '.psd1'))
    Import-Module -Name $manifest -ErrorAction Stop
}
