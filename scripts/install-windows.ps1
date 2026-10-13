# 싹다클린 AI 비서 (윈도우용 설치)
# 필요한 프로그램이 있는지 확인하고, 필요한 파일을 내려받고, 바탕화면에 실행 아이콘을 만든다.
# 실행: powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
# 한글이 깨지지 않도록 이 파일은 UTF-8(BOM)으로 저장해야 한다.
# 프로그램 폴더(이 파일이 있는 scripts 폴더의 한 칸 위)로 간다
$AppDir = Split-Path -Parent $PSScriptRoot
Set-Location $AppDir
# Claude Code(claude.exe)가 설치되는 위치를 실행 경로에 넣는다
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
# 꼭 필요한 프로그램이 모두 있는지 (하나라도 없으면 아래에서 false로 바뀐다)
$allFound = $true

# 프로그램 하나를 확인한 결과를 한 줄로 보여준다: 있으면 초록 [확인], 꼭 필요한데 없으면 빨강 [없음]과 설치 명령, 없어도 되는 것이면 노랑 [선택]
function Check($name, $found, $howToInstall, $required = $true) {
  if ($found) {
    Write-Host "[확인] $name" -ForegroundColor Green
  } elseif ($required) {
    Write-Host "[없음] $name  ->  $howToInstall" -ForegroundColor Red
    $script:allFound = $false
  } else {
    Write-Host "[선택] $name 없음  ->  $howToInstall" -ForegroundColor Yellow
  }
}

# Node.js가 있고 버전이 22 이상인지 확인한다
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $major = [int]((& node --version).TrimStart('v').Split('.')[0])
  $nodeOk = $major -ge 22
}
Check 'Node.js 22 이상' $nodeOk 'winget install OpenJS.NodeJS.LTS'
# 문의를 분석할 AI 프로그램: Codex(ChatGPT 구독)나 Claude Code(Claude 구독) 중 하나는 있어야 한다
$hasAi = [bool](Get-Command codex -ErrorAction SilentlyContinue) -or [bool](Get-Command claude -ErrorAction SilentlyContinue)
Check 'AI 프로그램 (Codex 또는 Claude Code)' $hasAi 'npm install -g @openai/codex'
# 밖에서 접속: Tailscale이 있으면 바뀌지 않는 주소를 쓰고, 없으면 cloudflared의 임시 주소를 쓴다. 둘 다 없으면 같은 와이파이에서만 접속된다.
$tailscale = (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe") -or [bool](Get-Command tailscale -ErrorAction SilentlyContinue)
Check 'Tailscale (밖에서 접속, 주소 고정)' $tailscale 'winget install Tailscale.Tailscale' $false
if (-not $tailscale) {
  Check 'cloudflared (밖에서 접속, 주소가 켤 때마다 바뀜)' ([bool](Get-Command cloudflared -ErrorAction SilentlyContinue)) 'winget install Cloudflare.cloudflared' $false
}
# 크롬이 설치될 수 있는 세 곳 가운데 실제로 있는 곳을 찾는다
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ }
Check 'Google Chrome' ([bool]$chrome) 'winget install Google.Chrome'

# 꼭 필요한 프로그램이 하나라도 없으면 안내하고 끝낸다
if (-not $allFound) {
  Write-Host "`n없는 프로그램을 설치한 뒤, PowerShell 창을 새로 열고 이 스크립트를 다시 실행해 주세요." -ForegroundColor Yellow
  exit 1
}

# 프로그램이 쓰는 부품(playwright-core)을 내려받는다. 실패하면 알리고 끝낸다
Write-Host "`n필요한 파일을 내려받는 중입니다..."
& npm.cmd install
if ($LASTEXITCODE -ne 0) {
  Write-Host 'npm install에 실패했습니다. 위 오류 내용을 확인해 주세요.' -ForegroundColor Red
  exit 1
}

# 바탕화면에 실행 아이콘(바로 가기)을 만든다: 창을 띄우지 않고 start-windows.ps1을 실행하게 한다
$desktop = [Environment]::GetFolderPath('Desktop')
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut((Join-Path $desktop '싹다클린 AI 비서.lnk'))
$link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\scripts\start-windows.ps1`""
$link.WorkingDirectory = $AppDir
$link.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
$link.Description = '싹다클린 AI 비서 켜기·끄기'
$link.Save()

Write-Host "`n바탕화면에 '싹다클린 AI 비서' 아이콘을 만들었습니다. 두 번 눌러 켜 주세요." -ForegroundColor Green
Write-Host "프로그램 폴더를 옮기면 이 스크립트를 다시 실행해 아이콘을 새로 만들어야 합니다."
