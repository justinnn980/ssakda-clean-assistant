# 카톡 일감 도우미 한 번에 설치. 사이트의 '설치 파일 받기'(server.js의 /api/talk/setup.cmd)가 이 내용을 .cmd 파일에 넣어 내려준다.
# Node.js·Git이 없으면 설치하고, 프로그램을 받아(있으면 최신으로) install-kakaotalk-agent.ps1을 실행한다.
# .cmd 한 줄에 들어가야 해서(명령 줄 8천 자 제한) 짧게 쓴다.
$Repo = 'https://github.com/justinnn980/ssakda-clean-assistant.git'
$Dir = Join-Path $HOME 'ssakda-clean-assistant'
function Fresh { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Fail($m) { Write-Host "`n$m" -ForegroundColor Red; exit 1 }
Write-Host '카톡 일감 도우미를 설치합니다. 몇 분 걸릴 수 있습니다.' -ForegroundColor Green
Fresh
# 프로그램 설치 도구(winget)가 있어야 Node.js·Git을 설치할 수 있다
$need = @()
if (-not (Get-Command node -ErrorAction SilentlyContinue) -or [int]((node --version).TrimStart('v').Split('.')[0]) -lt 22) { $need += 'OpenJS.NodeJS.LTS' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { $need += 'Git.Git' }
if ($need.Count -and -not (Get-Command winget -ErrorAction SilentlyContinue)) { Fail 'winget이 없습니다. Microsoft Store에서 "앱 설치 관리자"를 설치한 뒤 다시 실행해 주세요.' }
foreach ($id in $need) {
  Write-Host "`n$id 설치 중... (허용 창이 뜨면 '예'를 눌러 주세요)"
  winget install -e --id $id --accept-source-agreements --accept-package-agreements
}
Fresh
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js를 설치하지 못했습니다. PC를 다시 켠 뒤 설치 파일을 다시 실행해 주세요.' }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git을 설치하지 못했습니다. PC를 다시 켠 뒤 설치 파일을 다시 실행해 주세요.' }
# 프로그램 받기(이미 있으면 최신으로)
Write-Host "`n프로그램을 받는 중..."
if (Test-Path "$Dir\.git") { git -C $Dir pull --ff-only } else { git clone $Repo $Dir }
if (-not (Test-Path "$Dir\scripts\install-kakaotalk-agent.ps1")) { Fail '프로그램을 받지 못했습니다. 인터넷 연결을 확인해 주세요.' }
# 바탕화면 아이콘·시작 프로그램을 만들고 켠다(접속 비밀번호를 묻는다)
& powershell -NoProfile -ExecutionPolicy Bypass -File "$Dir\scripts\install-kakaotalk-agent.ps1"
