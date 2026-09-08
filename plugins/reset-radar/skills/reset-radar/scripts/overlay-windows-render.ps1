function Percent($value) { if ($null -eq $value) { return '--' }; return ('{0:0.#}%' -f [double]$value) }

function Countdown($value, $now = [DateTimeOffset]::UtcNow) {
  if (-not $value) { return '时间暂不可用' }
  try { $span = ([DateTimeOffset]::Parse($value) - $now) } catch { return '时间暂不可用' }
  if ($span.TotalSeconds -le 0) { return '已到期 · 等待更新' }
  $days = [math]::Floor($span.TotalDays)
  if ($days -gt 0) { return ('{0}天 {1:00}:{2:00}:{3:00}' -f $days,$span.Hours,$span.Minutes,$span.Seconds) }
  return ('{0:00}:{1:00}:{2:00}' -f $span.Hours,$span.Minutes,$span.Seconds)
}

function Render($payload, $now = [DateTimeOffset]::UtcNow) {
  # Start empty on every update: loading, errors and missing rows must not retain old values.
  $Personal.Text = '--'
  $Base.Text = '--'
  $WindowProbability.Text = '--'
  $Countdown.Text = '时间暂不可用'
  $Usage.Text = '用量暂不可用'
  $Refresh.IsEnabled = $false
  $RefreshHint.Text = '自动刷新'
  $Message.Text = '展示数据暂不可用，等待更新。'
  if ($null -eq $payload) { return }

  $report = $payload.report
  if ($payload.status -eq 'ready' -and $report) {
    $Base.Text = Percent $report.baseProbability
    $windowItem = @($report.weeklyWindows | Where-Object { $_.limitId -eq 'codex' }) | Select-Object -First 1
    if ($windowItem) {
      $Countdown.Text = Countdown $windowItem.resetAt $now
      $validWindow = $false
      try { $validWindow = [DateTimeOffset]::Parse($windowItem.resetAt) -gt $now } catch {}
      if ($validWindow) {
        $Personal.Text = Percent $report.personalProbability
        $WindowProbability.Text = Percent $windowItem.personalProbability
        if ($null -ne $windowItem.usedPercent) {
          $Usage.Text = ('已用 {0:0.#}% · 剩余 {1:0.#}%' -f [double]$windowItem.usedPercent,[math]::Max(0,100-[double]$windowItem.usedPercent))
        }
      }
    }
  }
  $Message.Text = if ($payload.message) { $payload.message } elseif ($payload.status -eq 'ready') { '24 小时内仅计额外重置' } else { '正在读取雷达与周额度…' }
  $Refresh.IsEnabled = [bool]$payload.canRefresh
  $RefreshHint.Text = if ($payload.refreshing) { '正在刷新…' } elseif ($payload.canRefresh) { '点击刷新' } else { '自动刷新' }
}
