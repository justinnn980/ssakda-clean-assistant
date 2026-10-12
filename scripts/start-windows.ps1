# 싹다클린 AI 비서 (윈도우용 실행기)
# 바탕화면 아이콘을 누르면 실행된다. 꺼져 있으면 켜고 화면을 열고, 켜져 있으면 화면 열기·끄기를 고른다.
# 한글이 깨지지 않도록 이 파일은 UTF-8(BOM)으로 저장해야 한다.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$AppDir = Split-Path -Parent $PSScriptRoot
$Url = 'http://localhost:3210'
$Title = '싹다클린 AI 비서'
Set-Location $AppDir
# Claude Code(claude.exe)가 설치되는 위치를 실행 경로에 넣는다
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"

function Show-Box($text, $buttons = 'OK', $icon = 'Information') {
  return [System.Windows.Forms.MessageBox]::Show($text, $Title, $buttons, $icon)
}

function Test-Running {
  try { return (Invoke-WebRequest -Uri "$Url/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

function Get-Pin {
  if (-not (Test-Path '.env')) { return '' }
  $m = Select-String -Path '.env' -Pattern '^ACCESS_PIN=(.*)$' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return ''
}

if (Test-Running) {
  $answer = Show-Box "지금 켜져 있습니다.`n`n접속 비밀번호: $(Get-Pin)`n`n[예] 화면 열기`n[아니요] 프로그램 끄기`n[취소] 닫기" 'YesNoCancel'
  if ($answer -eq 'Yes') {
    Start-Process $Url
  } elseif ($answer -eq 'No') {
    # 서버와 함께 띄운 프로그램(숨고 크롬 창, 외부 접속)까지 같이 끈다
    if (Test-Path 'data\server.pid') { & taskkill.exe /PID (Get-Content 'data\server.pid') /T /F | Out-Null }
    Show-Box "껐습니다.`n`n다시 켜려면 이 아이콘을 두 번 누르세요." | Out-Null
  }
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Show-Box "Node.js가 설치되어 있지 않습니다.`n설치 가이드(INSTALL-WINDOWS.md)의 1단계를 먼저 진행해 주세요." 'OK' 'Warning' | Out-Null
  exit 1
}

New-Item -ItemType Directory -Force 'data' | Out-Null

# 켤 때마다 GitHub에서 최신 버전을 받아 온다. 인터넷이 안 되거나 받지 못해도 지금 있는 버전으로 그대로 켠다.
# (출력은 cmd가 파일로 넘긴다. PowerShell에서 직접 넘기면 경고 한 줄에도 스크립트가 멈춘다.)
$needInstall = -not (Test-Path 'node_modules')
if (Get-Command git -ErrorAction SilentlyContinue) {
  $before = (& git rev-parse HEAD)
  cmd /c "git pull --ff-only > data\update.log 2>&1"
  if ((& git rev-parse HEAD) -ne $before) { $needInstall = $true }
}
if ($needInstall) { cmd /c "npm install > data\npm-install.log 2>&1" }

$server = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $AppDir -WindowStyle Hidden `
  -RedirectStandardOutput 'data\server.log' -RedirectStandardError 'data\server-error.log' -PassThru

# 켜져 있는 동안 노트북이 저절로 잠들지 않게 한다. 서버가 꺼지면 같이 끝난다.
$keepAwake = @"
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
while (Get-Process -Id $($server.Id) -ErrorAction SilentlyContinue) { [Win32.Power]::SetThreadExecutionState(1) | Out-Null; Start-Sleep -Seconds 30 }
"@
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($keepAwake))
Start-Process -FilePath 'powershell' -ArgumentList "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded" -WindowStyle Hidden

$started = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Running) { $started = $true; break }
  if ($server.HasExited) { break }
}

if ($started) {
  Show-Box "켜졌습니다.`n`n접속 비밀번호: $(Get-Pin)`n`n확인을 누르면 화면이 열립니다.`n노트북 덮개를 닫으면 멈추니 열어 두세요." | Out-Null
  Start-Process $Url
} else {
  Show-Box "켜지지 않았습니다.`n`n$AppDir\data\server-error.log 파일을 확인하거나 도움을 요청해 주세요." 'OK' 'Warning' | Out-Null
}
