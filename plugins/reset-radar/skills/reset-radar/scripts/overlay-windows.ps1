param(
  [Parameter(Mandatory=$true)][string]$StatePath,
  [Parameter(Mandatory=$true)][string]$CommandPath
)

$ErrorActionPreference = 'Stop'
. ([System.IO.Path]::Combine($PSScriptRoot, 'windows-private-file-library.ps1'))
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="Reset Radar" Width="340" SizeToContent="Height"
        WindowStyle="None" ResizeMode="NoResize" AllowsTransparency="True"
        Background="Transparent" Topmost="True" ShowInTaskbar="False">
  <Border Background="#252131" BorderBrush="#5A4A70" BorderThickness="1" CornerRadius="20">
    <Grid>
      <Grid.RowDefinitions><RowDefinition Height="Auto"/><RowDefinition Height="*"/><RowDefinition Height="Auto"/></Grid.RowDefinitions>
      <Border Grid.Row="0" BorderBrush="#514161" BorderThickness="0,0,0,1" Padding="18,15,12,14" Name="Header">
        <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="36"/><ColumnDefinition Width="36"/><ColumnDefinition Width="36"/></Grid.ColumnDefinitions>
          <StackPanel Orientation="Horizontal"><TextBlock Text="◉" Foreground="#B596FF" FontSize="25" Margin="0,-4,10,0"/><TextBlock Text="Reset Radar" Foreground="#F3EDFF" FontSize="22" FontWeight="SemiBold"/></StackPanel>
          <Button Name="Refresh" Grid.Column="1" Content="↻" FontSize="24" Foreground="#EBDDFF" Background="Transparent" BorderThickness="0" ToolTip="刷新"/>
          <Button Name="Collapse" Grid.Column="2" Content="−" FontSize="24" Foreground="#EBDDFF" Background="Transparent" BorderThickness="0" ToolTip="收起"/>
          <Button Name="Close" Grid.Column="3" Content="×" FontSize="27" Foreground="#EBDDFF" Background="Transparent" BorderThickness="0" ToolTip="关闭"/>
        </Grid>
      </Border>
      <StackPanel Grid.Row="1" Name="Body" Margin="27,23,27,20">
        <Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions>
          <StackPanel><TextBlock Text="个人重置概率" Foreground="#F3EDFF" FontSize="19"/><TextBlock Text="未来 24 小时" Foreground="#B9ADC9" FontSize="16" Margin="0,5,0,0"/></StackPanel>
          <TextBlock Name="Personal" Grid.Column="1" Text="--" Foreground="#B596FF" FontSize="58" FontWeight="Bold" VerticalAlignment="Center"/>
        </Grid>
        <Border Background="#342D47" CornerRadius="10" Margin="0,23,0,0" Padding="15,13"><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><TextBlock Text="额外重置概率" Foreground="#C4B8D4" FontSize="16"/><TextBlock Name="Base" Grid.Column="1" Text="--" Foreground="#F3EDFF" FontSize="20" FontWeight="SemiBold"/></Grid></Border>
        <TextBlock Name="Message" Text="正在连接本机重置雷达…" Foreground="#C4B8D4" FontSize="15" Margin="0,18,0,0" TextWrapping="Wrap"/>
        <Border BorderBrush="#514161" BorderThickness="0,0,0,1" Margin="0,22,0,0" Padding="0,0,0,18"><StackPanel><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><TextBlock Text="Codex 周额度" Foreground="#C4B8D4" FontSize="16"/><TextBlock Name="WindowProbability" Grid.Column="1" Text="--" Foreground="#B596FF" FontSize="16" FontWeight="SemiBold"/></Grid><TextBlock Name="Countdown" Text="时间暂不可用" Foreground="#F3EDFF" FontSize="27" FontWeight="SemiBold" Margin="0,7,0,0"/><TextBlock Name="Usage" Text="用量暂不可用" Foreground="#C4B8D4" FontSize="16" Margin="0,6,0,0"/></StackPanel></Border>
      </StackPanel>
      <Border Grid.Row="2" BorderBrush="#514161" BorderThickness="0,1,0,0" Padding="24,14"><Grid><Grid.ColumnDefinitions><ColumnDefinition Width="*"/><ColumnDefinition Width="Auto"/></Grid.ColumnDefinitions><TextBlock Name="Updated" Text="雷达" Foreground="#C4B8D4" FontSize="14"/><TextBlock Name="RefreshHint" Grid.Column="1" Text="自动刷新" Foreground="#C4B8D4" FontSize="14"/></Grid></Border>
    </Grid>
  </Border>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)
$names = 'Header','Refresh','Collapse','Close','Body','Personal','Base','Message','WindowProbability','Countdown','Usage','Updated','RefreshHint'
foreach ($name in $names) { Set-Variable -Name $name -Value $window.FindName($name) }
$collapsed = $false
. (Join-Path $PSScriptRoot 'overlay-windows-render.ps1')

$Header.Add_MouseLeftButtonDown({ if ($_.ChangedButton -eq [System.Windows.Input.MouseButton]::Left) { $window.DragMove() } })
$Refresh.Add_Click({ [RadarPrivateFile]::Write($CommandPath, '{"type":"refresh"}') })
$Collapse.Add_Click({ $script:collapsed = -not $script:collapsed; $Body.Visibility = if ($script:collapsed) { 'Collapsed' } else { 'Visible' }; $Collapse.Content = if ($script:collapsed) { '+' } else { '−' } })
$Close.Add_Click({ $window.Close() })
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
  try { $payload = Get-Content -LiteralPath $StatePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop; Render $payload } catch { Render $null }
})
$window.Add_Loaded({
  $window.Left = [System.Windows.SystemParameters]::WorkArea.Right - $window.ActualWidth - 24
  $window.Top = [System.Windows.SystemParameters]::WorkArea.Bottom - $window.ActualHeight - 24
  $timer.Start()
  [Console]::Out.WriteLine('RESET_RADAR_READY')
  [Console]::Out.Flush()
})
$window.Add_Closed({ $timer.Stop() })
[void]$window.ShowDialog()
