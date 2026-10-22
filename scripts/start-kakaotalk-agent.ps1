# 카톡 일감 도우미 (윈도우용 실행기)
# 바탕화면의 '카톡 일감 도우미' 아이콘을 누르면 실행된다. 꺼져 있으면 켜고, 켜져 있으면 사이트 열기·끄기를 고른다.
# 처음에는 접속 비밀번호를 묻고 data/talk-agent.json에 저장한다. PC를 켤 때는 시작 프로그램에서 -Auto로 실행돼 창 없이 켠다.
# 한글이 깨지지 않도록 이 파일은 UTF-8(BOM)으로 저장해야 한다.
param([switch]$Auto)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, Microsoft.VisualBasic
# 프로그램 폴더(이 파일이 있는 scripts 폴더의 한 칸 위), 기본 서버 주소, 창 제목
$AppDir = Split-Path -Parent $PSScriptRoot
$Server = 'https://ssakda.sect.kr'
$Title = '카톡 일감 도우미'
Set-Location $AppDir
# 실행 경로를 윈도우에 저장된 값으로 다시 만든다(막 설치한 Node.js·Git을 찾을 수 있게)
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

# 알림 창을 띄우고, 누른 버튼을 돌려준다. 시작 프로그램으로 켤 때는 띄우지 않는다
function Show-Box($text, $buttons = 'OK', $icon = 'Information') {
  if ($Auto) { return 'OK' }
  return [System.Windows.Forms.MessageBox]::Show($text, $Title, $buttons, $icon)
}

# 도우미가 돌고 있으면 그 프로세스를 돌려준다
function Get-Agent {
  if (-not (Test-Path 'data\talk-agent.pid')) { return $null }
  $p = Get-Process -Id ([int](Get-Content 'data\talk-agent.pid')) -ErrorAction SilentlyContinue
  if ($p -and $p.ProcessName -eq 'node') { return $p }
  return $null
}

# 이미 켜져 있으면 사이트 열기·끄기·닫기 중에서 고르게 한 뒤 끝낸다
$running = Get-Agent
if ($running) {
  if ($Auto) { exit 0 }
  $answer = Show-Box "지금 켜져 있습니다.`n`n[예] 비서 사이트 열기`n[아니요] 도우미 끄기`n[취소] 닫기" 'YesNoCancel'
  if ($answer -eq 'Yes') {
    $cfg = Get-Content 'data\talk-agent.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    Start-Process $cfg.server
  } elseif ($answer -eq 'No') {
    # 지켜보기와 화면 꺼짐 방지까지 같이 끈다
    & taskkill.exe /PID $running.Id /T /F | Out-Null
    Remove-Item 'data\talk-agent.pid' -ErrorAction SilentlyContinue
    Show-Box "껐습니다.`n`n다시 켜려면 이 아이콘을 두 번 누르세요." | Out-Null
  }
  exit 0
}

# Node.js가 없으면 안내하고 끝낸다
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Show-Box "Node.js가 설치되어 있지 않습니다.`n사용 안내의 '카톡 일감 잡기' 설치를 먼저 해 주세요." 'OK' 'Warning' | Out-Null
  exit 1
}
New-Item -ItemType Directory -Force 'data' | Out-Null

# 켤 때마다 GitHub에서 최신 버전을 받아 온다. 받지 못해도 지금 있는 버전으로 켠다
if (Get-Command git -ErrorAction SilentlyContinue) { cmd /c "git pull --ff-only > data\talk-agent-update.log 2>&1" }

# 처음이면 접속 비밀번호를 물어 저장한다. 틀리면 다시 묻는다
while (-not (Test-Path 'data\talk-agent.json')) {
  if ($Auto) { exit 1 }
  $pin = [Microsoft.VisualBasic.Interaction]::InputBox("비서 사이트($Server)의 접속 비밀번호를 넣어 주세요.`n처음 한 번만 넣으면 됩니다.", $Title, '')
  if (-not $pin) { exit 0 }
  $out = (& node 'scripts\kakaotalk-agent.mjs' '--setup' $Server $pin | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Show-Box "연결하지 못했습니다.`n`n$out" 'OK' 'Warning' | Out-Null }
}

# 도우미를 창 없이 실행한다. 기록은 data 폴더에 남긴다
$agent = Start-Process -FilePath 'node' -ArgumentList 'scripts\kakaotalk-agent.mjs' -WorkingDirectory $AppDir -WindowStyle Hidden `
  -RedirectStandardOutput 'data\talk-agent.log' -RedirectStandardError 'data\talk-agent-error.log' -PassThru
Start-Sleep -Seconds 3
if ($agent.HasExited) {
  Show-Box "켜지지 않았습니다.`n`n$AppDir\data\talk-agent-error.log 파일을 확인하거나 도움을 요청해 주세요." 'OK' 'Warning' | Out-Null
  exit 1
}
Show-Box "켜졌습니다.`n`n비서 사이트 첫 화면의 '카톡 일감 잡기'에서 켜고 끌 수 있습니다.`n지켜볼 카카오톡 방은 열어 두세요(최소화하지 말고, 다른 창 뒤에 두는 것은 괜찮습니다)." | Out-Null
