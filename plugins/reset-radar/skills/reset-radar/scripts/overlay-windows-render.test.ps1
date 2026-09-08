$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'These assertions must run in native Windows PowerShell 5.1.'
}
. (Join-Path $PSScriptRoot 'overlay-windows-render.ps1')

$script:assertions = 0
$script:now = [DateTimeOffset]::Parse('2026-09-08T00:00:00Z')
$script:current = $null
foreach ($name in @('Personal','Base','WindowProbability','Countdown','Usage','Message','Refresh','RefreshHint')) {
  Set-Variable -Scope Script -Name $name -Value ([pscustomobject]@{ Text = ''; IsEnabled = $false })
}

function Assert-Equal($Actual, $Expected, [string]$Label) {
  $script:assertions += 1
  if ($Actual -cne $Expected) { throw ('{0}: expected [{1}], got [{2}]' -f $Label, $Expected, $Actual) }
}
function Assert-True([bool]$Condition, [string]$Label) {
  $script:assertions += 1
  if (-not $Condition) { throw $Label }
}
function New-ReadyPayload {
  return [pscustomobject]@{
    status = 'ready'; message = ''; refreshing = $false; canRefresh = $true
    report = [pscustomobject]@{
      personalProbability = 100; baseProbability = 37; reason = 'weekly_reset_within_24h'
      calculatedAt = $script:now.ToString('o'); radarGeneratedAt = $script:now.AddMinutes(-1).ToString('o')
      weeklyWindows = @([pscustomobject]@{
        limitId = 'codex'; window = 'secondary'; personalProbability = 100; usedPercent = 95
        reason = 'weekly_reset_within_24h'; resetAt = $script:now.AddHours(1).ToString('o')
      })
    }
  }
}
function Assert-NoWeeklyDisplay([string]$Label) {
  Assert-Equal $Personal.Text '--' "$Label personal probability"
  Assert-Equal $WindowProbability.Text '--' "$Label weekly probability"
  Assert-True (-not ($Usage.Text -match '95%|5%')) "$Label must clear previous usage"
  Assert-True ($Countdown.Text -ne '01:00:00') "$Label must clear the previous future countdown"
}
function Assert-ReadyDisplay([string]$Label) {
  Assert-Equal $Personal.Text '100%' "$Label personal probability"
  Assert-Equal $Base.Text '37%' "$Label extra probability"
  Assert-Equal $WindowProbability.Text '100%' "$Label weekly probability"
  Assert-True ($Usage.Text.Contains('95%')) "$Label must show current used quota"
  Assert-True ($Usage.Text -match '(?<![0-9])5%$') "$Label must show current remaining quota"
  Assert-Equal $Countdown.Text '01:00:00' "$Label countdown"
}

Render (New-ReadyPayload) $now
Assert-ReadyDisplay 'initial ready'

foreach ($status in @('loading', 'error')) {
  Render (New-ReadyPayload) $now
  Render ([pscustomobject]@{
    status = $status; report = $null; message = $status; refreshing = $false; canRefresh = $false
  }) $now
  Assert-NoWeeklyDisplay "$status without report"
  Assert-Equal $Base.Text '--' "$status must clear extra probability"
  Assert-Equal $Refresh.IsEnabled $false "$status refresh availability"

  Render (New-ReadyPayload) $now
  $oldReport = New-ReadyPayload
  $oldReport.status = $status
  Render $oldReport $now
  Assert-NoWeeklyDisplay "$status with old report"
  Assert-Equal $Base.Text '--' "$status cannot revive a stale report"
}

Render (New-ReadyPayload) $now
Render $null $now
Assert-NoWeeklyDisplay 'null payload'
Assert-Equal $Base.Text '--' 'null payload must clear extra probability'
Assert-Equal $Refresh.IsEnabled $false 'null payload must disable refresh'

Render (New-ReadyPayload) $now
$empty = New-ReadyPayload
$empty.report.weeklyWindows = @()
Render $empty $now
Assert-NoWeeklyDisplay 'missing general weekly quota'
Assert-Equal $Base.Text '37%' 'missing quota keeps fresh extra probability'

Render (New-ReadyPayload) $now
$modelOnly = New-ReadyPayload
$modelOnly.report.weeklyWindows[0].limitId = 'codex_bengalfox'
Render $modelOnly $now
Assert-NoWeeklyDisplay 'model-specific quota'
Assert-Equal $Base.Text '37%' 'model-specific quota keeps fresh extra probability'

foreach ($offset in @(-1, 0, 1)) {
  Render (New-ReadyPayload) $now
  $boundary = New-ReadyPayload
  $boundary.report.weeklyWindows[0].resetAt = $now.AddSeconds($offset).ToString('o')
  Render $boundary $now
  if ($offset -le 0) {
    Assert-NoWeeklyDisplay "reset boundary $offset"
    Assert-Equal $Base.Text '37%' "reset boundary $offset keeps fresh extra probability"
    Assert-True (-not [string]::IsNullOrWhiteSpace($Countdown.Text)) 'expired reset retains a readable countdown state'
  } else {
    Assert-Equal $Personal.Text '100%' 'one second before reset keeps personal probability'
    Assert-Equal $WindowProbability.Text '100%' 'one second before reset keeps weekly probability'
    Assert-True ($Usage.Text.Contains('95%')) 'one second before reset keeps current usage'
    Assert-Equal $Countdown.Text '00:00:01' 'one second before reset countdown'
  }
}

Render (New-ReadyPayload) $now
Assert-ReadyDisplay 'recovered ready'
Write-Output ('Windows renderer assertions passed ({0} checks).' -f $script:assertions)
