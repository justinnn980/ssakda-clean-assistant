# 카톡 일감 도우미 설치 (윈도우)
# 카카오톡이 있는 PC에서 한 번 실행한다. 바탕화면에 '카톡 일감 도우미' 아이콘을 만들고, PC를 켤 때 저절로 켜지게 한 뒤 바로 켠다.
# 실행: powershell -ExecutionPolicy Bypass -File scripts\install-kakaotalk-agent.ps1
# 한글이 깨지지 않도록 이 파일은 UTF-8(BOM)으로 저장해야 한다.
$AppDir = Split-Path -Parent $PSScriptRoot
Set-Location $AppDir
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')

# Node.js 22 이상과 PC 카카오톡이 있어야 한다
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) { $nodeOk = [int]((& node --version).TrimStart('v').Split('.')[0]) -ge 22 }
if (-not $nodeOk) {
  Write-Host '[없음] Node.js 22 이상  ->  winget install OpenJS.NodeJS.LTS' -ForegroundColor Red
  exit 1
}
Write-Host '[확인] Node.js' -ForegroundColor Green
if (-not (Get-Process KakaoTalk -ErrorAction SilentlyContinue) -and -not (Test-Path "${env:ProgramFiles(x86)}\Kakao\KakaoTalk\KakaoTalk.exe") -and -not (Test-Path "$env:ProgramFiles\Kakao\KakaoTalk\KakaoTalk.exe")) {
  Write-Host '[없음] PC 카카오톡  ->  https://www.kakaocorp.com/page/service/service/KakaoTalk 에서 설치' -ForegroundColor Red
  exit 1
}
Write-Host '[확인] PC 카카오톡' -ForegroundColor Green

# 바로 가기 하나를 만든다: 창 없이 start-kakaotalk-agent.ps1을 실행한다
function New-Link($file, $extra) {
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($file)
  $link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
  $link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AppDir\scripts\start-kakaotalk-agent.ps1`" $extra"
  $link.WorkingDirectory = $AppDir
  $link.IconLocation = "$env:SystemRoot\System32\shell32.dll,160"
  $link.Description = '카톡 일감 도우미 켜기·끄기'
  $link.Save()
}
# 바탕화면 아이콘과, PC를 켤 때 저절로 켜는 시작 프로그램
New-Link (Join-Path ([Environment]::GetFolderPath('Desktop')) '카톡 일감 도우미.lnk') ''
New-Link (Join-Path ([Environment]::GetFolderPath('Startup')) '카톡 일감 도우미.lnk') '-Auto'
Write-Host "`n바탕화면에 '카톡 일감 도우미' 아이콘을 만들었습니다. PC를 켤 때도 저절로 켜집니다." -ForegroundColor Green

# 바로 켠다(처음이면 접속 비밀번호를 묻는다)
& powershell -NoProfile -ExecutionPolicy Bypass -File "$AppDir\scripts\start-kakaotalk-agent.ps1"
