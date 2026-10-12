# 싹다클린 AI 비서 (윈도우용 설치)
# 필요한 프로그램이 있는지 확인하고, 필요한 파일을 내려받고, 바탕화면에 실행 아이콘을 만든다.
# 실행: powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
# 한글이 깨지지 않도록 이 파일은 UTF-8(BOM)으로 저장해야 한다.
$AppDir = Split-Path -Parent $PSScriptRoot
Set-Location $AppDir
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
$allFound = $true

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

$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  $major = [int]((& node --version).TrimStart('v').Split('.')[0])
  $nodeOk = $major -ge 22
}
Check 'Node.js 22 이상' $nodeOk 'winget install OpenJS.NodeJS.LTS'
Check 'Claude Code' ([bool](Get-Command claude -ErrorAction SilentlyContinue)) 'irm https://claude.ai/install.ps1 | iex'
# 밖에서 접속: Tailscale이 있으면 바뀌지 않는 주소를 쓰고, 없으면 cloudflared의 임시 주소를 쓴다. 둘 다 없으면 같은 와이파이에서만 접속된다.
$tailscale = (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe") -or [bool](Get-Command tailscale -ErrorAction SilentlyContinue)
Check 'Tailscale (밖에서 접속, 주소 고정)' $tailscale 'winget install Tailscale.Tailscale' $false
if (-not $tailscale) {
  Check 'cloudflared (밖에서 접속, 주소가 켤 때마다 바뀜)' ([bool](Get-Command cloudflared -ErrorAction SilentlyContinue)) 'winget install Cloudflare.cloudflared' $false
}
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ }
Check 'Google Chrome' ([bool]$chrome) 'winget install Google.Chrome'

if (-not $allFound) {
  Write-Host "`n없는 프로그램을 설치한 뒤, PowerShell 창을 새로 열고 이 스크립트를 다시 실행해 주세요." -ForegroundColor Yellow
  exit 1
}

Write-Host "`n필요한 파일을 내려받는 중입니다..."
& npm.cmd install
if ($LASTEXITCODE -ne 0) {
  Write-Host 'npm install에 실패했습니다. 위 오류 내용을 확인해 주세요.' -ForegroundColor Red
  exit 1
}

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
