# 싹다클린 AI 비서 (윈도우용 실행기)
# 바탕화면 아이콘을 누르면 실행된다. 꺼져 있으면 켜고 화면을 열고, 켜져 있으면 화면 열기·끄기를 고른다.
# 한글이 깨지지 않도록 이 파일은 UTF-8(BOM)으로 저장해야 한다.
# 오류가 나면 계속하지 않고 멈춘다
$ErrorActionPreference = 'Stop'
# 알림 창(메시지 상자)을 띄우는 기능을 불러온다
Add-Type -AssemblyName System.Windows.Forms
# 프로그램 폴더(이 파일이 있는 scripts 폴더의 한 칸 위), 화면 주소, 창 제목
$AppDir = Split-Path -Parent $PSScriptRoot
$Url = 'http://localhost:3210'
$Title = '싹다클린 AI 비서'
# 프로그램 폴더로 간다
Set-Location $AppDir
# 실행 경로를 윈도우에 저장된 값(컴퓨터 전체 + 이 사용자)으로 다시 만든다.
# 바탕화면은 프로그램을 막 설치했을 때 예전 경로를 들고 있어서 Node.js 등을 못 찾기 때문이다.
# 그리고 Claude Code(claude.exe)가 설치되는 위치를 붙인다
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') + ";$env:USERPROFILE\.local\bin"

# 알림 창을 띄우고, 누른 버튼을 돌려준다
function Show-Box($text, $buttons = 'OK', $icon = 'Information') {
  return [System.Windows.Forms.MessageBox]::Show($text, $Title, $buttons, $icon)
}

# 프로그램이 켜져 있는지 확인한다: 화면 주소를 2초 안에 불러 봐서 정상 응답(200)이 오면 켜져 있는 것
function Test-Running {
  try { return (Invoke-WebRequest -Uri "$Url/" -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { return $false }
}

# .env 파일에서 접속 비밀번호를 읽는다. 없으면 빈 글자
function Get-Pin {
  if (-not (Test-Path '.env')) { return '' }
  $m = Select-String -Path '.env' -Pattern '^ACCESS_PIN=(.*)$' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return ''
}

# 이미 켜져 있으면 비밀번호를 보여주고 화면 열기·끄기·닫기 중에서 고르게 한 뒤 끝낸다
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

# Node.js가 없으면 설치 안내를 띄우고 끝낸다
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Show-Box "Node.js가 설치되어 있지 않습니다.`n설치 가이드(INSTALL-WINDOWS.md)의 1단계를 먼저 진행해 주세요." 'OK' 'Warning' | Out-Null
  exit 1
}

# 자료와 기록을 둘 data 폴더를 만든다 (이미 있으면 그대로 둔다)
New-Item -ItemType Directory -Force 'data' | Out-Null

# 켤 때마다 GitHub에서 최신 버전을 받아 온다. 인터넷이 안 되거나 받지 못해도 지금 있는 버전으로 그대로 켠다.
# (출력은 cmd가 파일로 넘긴다. PowerShell에서 직접 넘기면 경고 한 줄에도 스크립트가 멈춘다.)
# 처음이라 내려받은 부품(node_modules)이 없으면 설치가 필요하다고 표시해 둔다
$needInstall = -not (Test-Path 'node_modules')
# git이 있으면 최신 버전을 받아 오고, 실제로 바뀐 것이 있으면 부품도 다시 설치하게 한다
if (Get-Command git -ErrorAction SilentlyContinue) {
  $before = (& git rev-parse HEAD)
  cmd /c "git pull --ff-only > data\update.log 2>&1"
  if ((& git rev-parse HEAD) -ne $before) { $needInstall = $true }
}
# 필요하면 부품을 설치한다 (기록은 data 폴더의 npm-install.log)
if ($needInstall) { cmd /c "npm install > data\npm-install.log 2>&1" }

# 서버를 창 없이 실행한다. 출력과 오류는 data 폴더의 파일에 남긴다
$server = Start-Process -FilePath 'node' -ArgumentList 'server.js' -WorkingDirectory $AppDir -WindowStyle Hidden `
  -RedirectStandardOutput 'data\server.log' -RedirectStandardError 'data\server-error.log' -PassThru

# 켜져 있는 동안 노트북이 저절로 잠들지 않게 한다. 서버가 꺼지면 같이 끝난다.
$keepAwake = @"
Add-Type -Namespace Win32 -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
while (Get-Process -Id $($server.Id) -ErrorAction SilentlyContinue) { [Win32.Power]::SetThreadExecutionState(1) | Out-Null; Start-Sleep -Seconds 30 }
"@
# 위의 잠들지 않게 하는 명령을 숨겨진 PowerShell 창에서 따로 실행한다
$encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($keepAwake))
Start-Process -FilePath 'powershell' -ArgumentList "-NoProfile -WindowStyle Hidden -EncodedCommand $encoded" -WindowStyle Hidden

# 켜질 때까지 1초 간격으로 40번까지 확인한다. 서버가 도중에 꺼지면 그만 기다린다
$started = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Running) { $started = $true; break }
  if ($server.HasExited) { break }
}

# 켜졌으면 비밀번호를 보여주고 화면을 연다. 켜지지 않았으면 오류 기록 파일의 위치를 알려준다
if ($started) {
  Show-Box "켜졌습니다.`n`n접속 비밀번호: $(Get-Pin)`n`n확인을 누르면 화면이 열립니다.`n노트북 덮개를 닫으면 멈추니 열어 두세요." | Out-Null
  Start-Process $Url
} else {
  Show-Box "켜지지 않았습니다.`n`n$AppDir\data\server-error.log 파일을 확인하거나 도움을 요청해 주세요." 'OK' 'Warning' | Out-Null
}
