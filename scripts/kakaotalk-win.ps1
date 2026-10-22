# 윈도우용 카카오톡 창을 읽고 조작한다. lib/kakaotalk.js가 이렇게 실행한다:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/kakaotalk-win.ps1 rooms
#   ... peek <방 이름>
#   ... send <방 이름> <보낼 글>
#   ... direct <방 이름> <보낼 글> <일감 글 본문> [dry]
# 윈도우 카카오톡은 채팅 글을 접근성 정보(UI Automation)로 보여 주지 않는다(2026-10-22 확인: 방 이름·입력칸만 잡힌다).
# 그래서 채팅방 창을 찍어 윈도우 기본 글자 인식(OCR, 한국어)으로 읽는다. 창이 다른 창에 가려져 있어도 되지만 최소화돼 있으면 안 된다.
# 결과는 JSON 한 줄로 돌려준다. 한글 때문에 이 파일은 UTF-8(BOM)·CRLF로 저장한다.
param([string]$Cmd, [string]$Room, [string]$Text, [string]$RowText, [string]$Flag)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 윈도우의 기능을 불러온다: 접근성(UI Automation), 그림, 키보드, 창·마우스 조작
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System; using System.Runtime.InteropServices;
public static class KakaoWin {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, IntPtr e);
  public struct RECT { public int L, T, R, B; }
  public struct POINT { public int X, Y; }
}
'@
# 화면 배율을 쓰는 PC에서도 창 위치·그림·마우스 자리가 같은 단위(실제 화면 점)가 되게 한다
[void][KakaoWin]::SetProcessDPIAware()

# 윈도우 기본 글자 인식(OCR)을 불러온다. 비동기 함수는 끝날 때까지 기다려 결과를 받는다
[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
[void][Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $task.Wait(); $task.Result }

$UIA = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]

# 결과를 JSON 한 줄로 내보낸다
function Out-Json($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)) }

# 글자를 비교할 때 띄어쓰기·괄호·이모티콘처럼 글자 인식이 자주 틀리는 것을 뺀다(한글·영문·숫자만 남긴다)
function Squash([string]$s) { ($s -replace '[^0-9A-Za-z가-힣]', '') }

# ---------- 카카오톡 창 찾기 ----------

# 실행 중인 카카오톡. 켜져 있지 않으면 그렇다고 알린다
function Get-Kakao {
  $p = Get-Process KakaoTalk -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $p) { throw '카카오톡이 켜져 있지 않습니다.' }
  $p
}

# 카카오톡의 창들: 접근성 요소, 이름, 창 번호
function Get-KakaoWindows {
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ProcessIdProperty, (Get-Kakao).Id)
  foreach ($w in $UIA::RootElement.FindAll($Scope::Children, $cond)) {
    [pscustomobject]@{ El = $w; Name = [string]$w.Current.Name; Hwnd = [IntPtr]$w.Current.NativeWindowHandle }
  }
}

# 채팅 목록이 있는 첫 창(이름이 '카카오톡')
function Get-MainWindow {
  $main = Get-KakaoWindows | Where-Object { $_.Name -eq '카카오톡' } | Select-Object -First 1
  if (-not $main) { throw '카카오톡 창이 닫혀 있습니다. 카카오톡 창을 열어 주세요.' }
  Show-NoActivate $main
  $main
}

# 최소화된 창은 찍히지 않아서, 앞으로 가져오지 않고 원래 크기로만 되돌린다
function Show-NoActivate($win) {
  if ([KakaoWin]::IsIconic($win.Hwnd)) {
    [void][KakaoWin]::ShowWindow($win.Hwnd, 4)
    Start-Sleep -Milliseconds 400
  }
}

# 이름이 name인 채팅방 창. 이름이 똑같은 창을 먼저 찾고, 없으면 이모티콘 등을 뺀 이름으로 찾는다. 없으면 null
function Find-ChatWindow([string]$name) {
  $wins = @(Get-KakaoWindows | Where-Object { $_.Name -ne '카카오톡' })
  $win = $wins | Where-Object { $_.Name -eq $name } | Select-Object -First 1
  if (-not $win -and (Squash $name)) { $win = $wins | Where-Object { (Squash $_.Name) -eq (Squash $name) } | Select-Object -First 1 }
  if ($win) { Show-NoActivate $win }
  $win
}

# 지켜볼 채팅방 창. 윈도우에서는 채팅 목록에서 방 이름을 정확히 읽을 수 없어 열려 있는 창만 쓴다
function Get-RoomWindow([string]$room) {
  $win = Find-ChatWindow $room
  if (-not $win) { throw "`"$room`" 채팅방 창이 열려 있지 않습니다. 카카오톡에서 그 방을 열어 두세요(최소화하지 말고 다른 창 뒤에 두는 것은 괜찮습니다)." }
  $win
}

# 창 안에서 클래스 이름이 cls인 요소(채팅 글 목록, 입력칸 등)
function Find-Child($win, [string]$cls) {
  $cond = New-Object System.Windows.Automation.PropertyCondition($UIA::ClassNameProperty, $cls)
  $win.El.FindFirst($Scope::Descendants, $cond)
}

# ---------- 찍어서 글자 읽기 ----------

# 창을 그림으로 찍는다(다른 창에 가려져 있어도 된다). 창의 화면 위치도 함께 돌려준다
function Capture($win) {
  $r = New-Object KakaoWin+RECT
  [void][KakaoWin]::GetWindowRect($win.Hwnd, [ref]$r)
  $bmp = New-Object System.Drawing.Bitmap ([Math]::Max(1, $r.R - $r.L)), ([Math]::Max(1, $r.B - $r.T))
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $hdc = $g.GetHdc()
  [void][KakaoWin]::PrintWindow($win.Hwnd, $hdc, 2)
  $g.ReleaseHdc($hdc); $g.Dispose()
  [pscustomobject]@{ Bmp = $bmp; Left = $r.L; Top = $r.T }
}

# 그림의 (x, y, w, h) 부분에서 글자를 읽어 낱말 목록을 돌려준다. 위치는 창 그림 기준이다.
# 작은 글자는 잘못 읽는 일이 많아서 2배로 키워 읽는다(2026-10-22 시험: 키우지 않으면 문장 대부분이 틀렸다).
function Read-Words($bmp, [int]$x, [int]$y, [int]$w, [int]$h, [int]$zoom = 2) {
  $x = [Math]::Max(0, $x); $y = [Math]::Max(0, $y)
  $w = [Math]::Min($w, $bmp.Width - $x); $h = [Math]::Min($h, $bmp.Height - $y)
  if ($w -le 0 -or $h -le 0) { return @() }
  $big = New-Object System.Drawing.Bitmap ($w * $zoom), ($h * $zoom)
  $g = [System.Drawing.Graphics]::FromImage($big)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.Clear([System.Drawing.Color]::White)
  $g.DrawImage($bmp, (New-Object System.Drawing.Rectangle 0, 0, ($w * $zoom), ($h * $zoom)), (New-Object System.Drawing.Rectangle $x, $y, $w, $h), 'Pixel')
  $g.Dispose()
  # 그림을 OCR이 받는 모양으로 바꾼다(파일을 남기지 않고 메모리 안에서)
  $ms = New-Object System.IO.MemoryStream
  $big.Save($ms, [System.Drawing.Imaging.ImageFormat]::Bmp); $big.Dispose()
  $ras = [System.IO.WindowsRuntimeStreamExtensions]::AsRandomAccessStream($ms)
  $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('ko'))
  if (-not $engine) { throw '윈도우에 한국어 글자 인식(OCR)이 없습니다. 설정 > 시간 및 언어 > 언어에서 한국어를 추가해 주세요.' }
  $res = Await ($engine.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
  $ms.Dispose()
  # 낱말마다 글자와 위치(원래 크기로 되돌린 값), 몇 번째 줄인지
  $words = New-Object System.Collections.ArrayList
  $line = 0
  foreach ($l in $res.Lines) {
    foreach ($wd in $l.Words) {
      $b = $wd.BoundingRect
      [void]$words.Add([pscustomobject]@{ Text = $wd.Text; X = $x + $b.X / $zoom; Y = $y + $b.Y / $zoom; W = $b.Width / $zoom; H = $b.Height / $zoom; Line = $line })
    }
    $line++
  }
  , $words
}

# 낱말 바로 왼쪽의 바탕색으로 어디에 쓰인 글자인지 가린다: 노란 말풍선(내 글), 흰 말풍선(다른 사람 글), 그 밖(이름·시각 등 바탕 글자)
function Kind-Of($bmp, $word) {
  $px = [int]([Math]::Max(0, $word.X - 3)); $py = [int]([Math]::Min($bmp.Height - 1, $word.Y + $word.H / 2))
  $c = $bmp.GetPixel($px, $py)
  if ($c.R -gt 220 -and $c.G -gt 190 -and $c.B -lt 140) { return 'mine' }
  if ($c.R -gt 240 -and $c.G -gt 240 -and $c.B -gt 240) { return 'other' }
  'label'
}

# 글 한 줄(cur의 마지막 줄)과 그 아래 줄(next) 사이가 모두 말풍선 색인지 본다. 사이에 바탕색이 끼어 있으면 다른 말풍선이다
function Same-Bubble($bmp, $cur, $next) {
  if ($next.Top - $cur.Bottom -gt 40) { return $false }
  $x = [int]([Math]::Max(0, [Math]::Max($cur.X, $next.X) - 3))
  for ($y = [int]$cur.Bottom; $y -lt [int]$next.Top; $y++) {
    if ((Kind-Of $bmp ([pscustomobject]@{ X = $x + 3; Y = $y; H = 0 })) -ne $cur.Kind) { return $false }
  }
  $true
}

# 시각(오후 2:44)·날짜·읽지 않은 수(1)처럼 글이 아닌 바탕 글자
function Is-Noise([string]$s) {
  $t = $s -replace '\s', ''
  $t -match '^(오전|오후)[^가-힣]*$' -or $t -match '^[^가-힣A-Za-z]+$' -or $t -match '\d{4}년' -or $t -match '^\d+월\d+일'
}

# 채팅방 창에서 보이는 글들을 위에서부터 읽는다: 본문, 올린 사람(내 글이면 빈 글자, 이름이 화면 밖이면 '?')
function Read-Messages($win) {
  $list = Find-Child $win 'EVA_VH_ListControl_Dblclk'
  if (-not $list) { throw '채팅방 창에서 글 목록을 찾지 못했습니다.' }
  $shot = Capture $win
  try {
    $lr = $list.Current.BoundingRectangle
    $words = Read-Words $shot.Bmp ([int]($lr.X - $shot.Left)) ([int]($lr.Y - $shot.Top)) ([int]$lr.Width) ([int]$lr.Height)
    $width = $lr.Width
    # 같은 줄에서 바탕색이 같은 낱말끼리 묶는다(말풍선 글과 그 옆 시각이 한 줄로 읽혀도 나눠지게)
    $runs = New-Object System.Collections.ArrayList
    foreach ($wd in $words) {
      $kind = Kind-Of $shot.Bmp $wd
      $last = if ($runs.Count) { $runs[$runs.Count - 1] } else { $null }
      if ($last -and $last.Line -eq $wd.Line -and $last.Kind -eq $kind) {
        $last.Text += ' ' + $wd.Text; $last.Bottom = [Math]::Max($last.Bottom, $wd.Y + $wd.H)
      } else {
        [void]$runs.Add([pscustomobject]@{ Kind = $kind; Line = $wd.Line; Text = $wd.Text; Top = $wd.Y; Bottom = $wd.Y + $wd.H; X = $wd.X; LeftInList = $wd.X - ($lr.X - $shot.Left) })
      }
    }
    # 위에서부터 차례로 글을 만든다. 다른 사람 글은 바로 위에 이름이 있고, 같은 사람이 이어 쓴 글에는 이름이 없다
    $msgs = New-Object System.Collections.ArrayList
    $sender = '?'
    $cur = $null
    foreach ($r in ($runs | Sort-Object Top, LeftInList)) {
      if ($r.Kind -eq 'label') {
        # 왼쪽에 있는 바탕 글자 가운데 시각·날짜가 아닌 것이 올린 사람 이름이다
        if (-not (Is-Noise $r.Text) -and $r.LeftInList -lt $width * 0.4) { $sender = $r.Text.Trim(); $cur = $null }
        continue
      }
      # 같은 말풍선의 다음 줄이면 이어 붙이고, 아니면 새 글로 시작한다. 두 줄 사이가 끊김 없이 말풍선 색이면 같은 말풍선이다(빈 줄이 든 글도 하나로 읽게)
      if ($cur -and $cur.Kind -eq $r.Kind -and (Same-Bubble $shot.Bmp $cur $r)) {
        $cur.Lines += $r.Text; $cur.Bottom = [Math]::Max($cur.Bottom, $r.Bottom); $cur.X = $r.X; continue
      }
      # 내 글 다음에 오는 다른 사람 글에는 반드시 이름이 붙으므로, 내 글을 만나면 올린 사람을 모르는 상태로 돌린다
      if ($r.Kind -eq 'mine') { $sender = '?' }
      $cur = [pscustomobject]@{ Kind = $r.Kind; Sender = $(if ($r.Kind -eq 'mine') { '' } else { $sender }); Lines = @($r.Text); Bottom = $r.Bottom; X = $r.X }
      [void]$msgs.Add($cur)
    }
    foreach ($m in $msgs) {
      $body = ($m.Lines -join "`n").Trim()
      # 답장(댓글)은 인용된 원래 글까지 함께 읽혀서, "마감" 같은 답장이 일감 글로 잡히지 않게 통째로 뺀다
      if ($body -match '에게\s*답장') { continue }
      if ($body) { [pscustomobject]@{ text = $body; sender = $m.Sender } }
    }
  } finally { $shot.Bmp.Dispose() }
}

# ---------- 명령 ----------

# 설정 화면에서 고를 수 있게 열려 있는 채팅방 창의 이름과 인원 수를 돌려준다.
# 윈도우에서는 채팅 목록의 방 이름을 글자 인식으로 정확히 읽을 수 없어서(이모티콘이 깨진다), 이름이 정확한 열린 창만 쓴다.
function Cmd-Rooms {
  $rooms = @()
  foreach ($win in (Get-KakaoWindows | Where-Object { $_.Name -and $_.Name -ne '카카오톡' })) {
    # 인원 수는 방 이름 아래 작은 숫자 하나라 글자 인식이 읽지 못하고(키워도 안 된다), 오픈채팅방인지도 창에서 알 수 없어 비워 둔다
    $rooms += [pscustomobject]@{ name = $win.Name; members = $null; open = $false }
  }
  if (-not $rooms.Count) { throw '열려 있는 채팅방 창이 없습니다. 카카오톡에서 지켜볼 방을 열어 두면 여기서 고를 수 있습니다.' }
  @{ rooms = $rooms }
}

# 방에 보이는 마지막 글 8개. index는 화면 안의 차례다(새 글 가리기는 lib/kakaotalk.js가 앞뒤 결과를 견주어 한다)
function Cmd-Peek([string]$room) {
  $msgs = @(Read-Messages (Get-RoomWindow $room))
  $from = [Math]::Max(0, $msgs.Count - 8)
  $rows = @()
  for ($i = $from; $i -lt $msgs.Count; $i++) { $rows += [pscustomobject]@{ index = $i; text = $msgs[$i].text; sender = $msgs[$i].sender } }
  @{ count = $msgs.Count; rows = $rows }
}

# 창을 맨 앞으로 올린다. 다른 프로그램이 앞에 있으면 윈도우가 막으므로 Alt를 한 번 눌렀다 떼고 다시 시도한다
function Bring-Front($win) {
  if ([KakaoWin]::IsIconic($win.Hwnd)) { [void][KakaoWin]::ShowWindow($win.Hwnd, 9) }
  for ($n = 0; $n -lt 3; $n++) {
    if ([KakaoWin]::GetForegroundWindow() -eq $win.Hwnd) { return }
    [KakaoWin]::keybd_event(0x12, 0, 0, [IntPtr]::Zero); [KakaoWin]::keybd_event(0x12, 0, 2, [IntPtr]::Zero)
    [void][KakaoWin]::SetForegroundWindow($win.Hwnd)
    Start-Sleep -Milliseconds 250
  }
  if ([KakaoWin]::GetForegroundWindow() -ne $win.Hwnd) { throw "`"$($win.Name)`" 창을 앞으로 가져오지 못해 보내지 않았습니다." }
}

# 입력칸의 지금 글. 비어 있을 때도 안내 글 '메시지 입력'이 값으로 읽혀서 그때는 빈 글자로 본다
function Input-Text($value) {
  $v = [string]$value.Current.Value
  if ($v -match '^(답장 )?메시지 입력$') { return '' }
  $v
}

# 앞에 있는 창의 입력칸에 글을 붙여넣는다(쓰던 글은 모두 골라 바꾼다). 클립보드는 원래대로 돌려놓는다
function Paste-Text([string]$text) {
  $saved = $null
  try { $saved = [System.Windows.Forms.Clipboard]::GetDataObject() } catch {}
  [System.Windows.Forms.Clipboard]::SetText($text)
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 200
  try { if ($saved) { [System.Windows.Forms.Clipboard]::SetDataObject($saved, $true) } else { [System.Windows.Forms.Clipboard]::Clear() } } catch {}
}

# 채팅방 창에 글을 보낸다. 입력칸에 쓰던 글이 있으면 보낸 뒤 되돌려 놓는다.
# 접근성으로 입력칸 값을 바꾸면 화면에만 들어가고 카카오톡은 빈칸으로 알아서(2026-10-22 확인: Enter를 눌러도 보내지지 않았다),
# 사람처럼 붙여넣고 Enter를 누른다. 그래서 이 창이 맨 앞이고 입력칸에 커서가 있을 때만 한다.
function Send-To($win, [string]$text) {
  $input = Find-Child $win 'RICHEDIT50W'
  if (-not $input) { throw '메시지 입력 칸을 찾지 못했습니다.' }
  $value = $input.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $draft = Input-Text $value
  Bring-Front $win
  $input.SetFocus()
  Start-Sleep -Milliseconds 150
  if ([KakaoWin]::GetForegroundWindow() -ne $win.Hwnd) { throw '채팅방 창이 맨 앞이 아니어서 보내지 않았습니다.' }
  Paste-Text $text
  # 붙여넣은 글이 입력칸에 그대로 들어갔는지 확인한 뒤 Enter를 누른다(창이 바뀌었으면 누르지 않는다)
  if ((Input-Text $value).Trim() -ne $text.Trim() -or [KakaoWin]::GetForegroundWindow() -ne $win.Hwnd) {
    if ([KakaoWin]::GetForegroundWindow() -eq $win.Hwnd) { Paste-Text $draft }
    throw '입력칸에 글을 넣지 못해 보내지 않았습니다.'
  }
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 500
  # 입력칸이 비워졌는지로 실제로 보내졌는지 확인한다
  if ((Input-Text $value).Trim() -eq $text.Trim()) { throw 'Enter를 눌렀지만 글이 보내지지 않았습니다.' }
  # 쓰던 글이 있었으면 되돌려 놓는다
  if ($draft) { Paste-Text $draft }
  @{ sent = $true }
}

# 화면의 (x, y) 자리를 실제 마우스로 두 번 누르고, 마우스를 원래 자리로 돌려놓는다
function Double-Click([int]$x, [int]$y) {
  $here = New-Object KakaoWin+POINT
  [void][KakaoWin]::GetCursorPos([ref]$here)
  [void][KakaoWin]::SetCursorPos($x, $y)
  Start-Sleep -Milliseconds 80
  for ($n = 0; $n -lt 2; $n++) {
    [KakaoWin]::mouse_event(0x02, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 30
    [KakaoWin]::mouse_event(0x04, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60
  }
  Start-Sleep -Milliseconds 150
  [void][KakaoWin]::SetCursorPos($here.X, $here.Y)
}

# 이름이 name인 1:1 채팅방 창. 열려 있으면 그 창을, 아니면 채팅 목록에서 그 이름의 줄을 찾아 두 번 눌러 연다.
# 단체방(이름 옆에 인원 수가 있는 줄)은 건너뛴다. 찾지 못하면 null
function Open-ExistingChat([string]$name) {
  $open = Find-ChatWindow $name
  if ($open) { return @{ Win = $open; WasOpen = $true } }
  $main = Get-MainWindow
  $list = Find-Child $main 'EVA_VH_ListControl_Dblclk'
  if (-not $list) { throw "카카오톡 창을 '채팅' 탭으로 두어야 1:1 채팅방을 찾을 수 있습니다." }
  $shot = Capture $main
  try {
    $lr = $list.Current.BoundingRectangle
    $words = Read-Words $shot.Bmp ([int]($lr.X - $shot.Left)) ([int]($lr.Y - $shot.Top)) ([int]$lr.Width) ([int]$lr.Height)
    # 위쪽에 '채팅' 글자가 있어야 채팅 탭이다(글자 인식이 '재팅'으로 읽기도 해서 '팅'으로 본다. 친구 탭은 '친구')
    $head = Read-Words $shot.Bmp 0 0 ([int]($shot.Bmp.Width * 0.6)) ([int]($lr.Y - $shot.Top))
    if (-not ($head | Where-Object { $_.Text -match '팅' })) { throw "카카오톡 창을 '채팅' 탭으로 두어야 1:1 채팅방을 찾을 수 있습니다." }
  } finally { $shot.Bmp.Dispose() }
  # 높이가 같은 낱말끼리 한 줄로 모은다(방 이름과 그 옆 인원 수가 따로 읽히기도 해서). 오른쪽 끝의 시각 칸은 뺀다
  $left = $lr.X - $shot.Left
  $lines = New-Object System.Collections.ArrayList
  foreach ($wd in ($words | Where-Object { $_.X - $left -lt $lr.Width * 0.75 } | Sort-Object Y)) {
    $last = if ($lines.Count) { $lines[$lines.Count - 1] } else { $null }
    if ($last -and [Math]::Abs($wd.Y - $last.Y) -lt 6) { $last.Words += $wd } else { [void]$lines.Add([pscustomobject]@{ Y = $wd.Y; Words = @($wd) }) }
  }
  # 이름이 같고 인원 수(숫자만 있는 낱말)가 붙지 않은 줄을 찾는다
  foreach ($ln in $lines) {
    $ws = @($ln.Words | Sort-Object X)
    $names = @($ws | Where-Object { $_.Text -notmatch '^\d+$' })
    if (-not $names.Count -or (Squash (($names | ForEach-Object Text) -join '')) -ne (Squash $name)) { continue }
    if ($ws | Where-Object { $_.Text -match '^\d+$' }) { continue }
    $before = @(Get-KakaoWindows | ForEach-Object { $_.Hwnd })
    Bring-Front $main
    Double-Click ([int]($shot.Left + $names[0].X + $names[0].W / 2)) ([int]($shot.Top + $names[0].Y + $names[0].H / 2))
    # 그 이름의 창이 뜰 때까지 3초까지 기다린다
    for ($n = 0; $n -lt 15; $n++) {
      Start-Sleep -Milliseconds 200
      $win = Get-KakaoWindows | Where-Object { $before -notcontains $_.Hwnd -and (Squash $_.Name) -eq (Squash $name) } | Select-Object -First 1
      if ($win) { return @{ Win = $win; WasOpen = $false } }
    }
    return $null
  }
  $null
}

# room 방에서 본문이 rowText인 글을 올린 사람에게 1:1 채팅으로 text를 보낸다.
# 윈도우에서는 프로필에서 대화를 거는 대신, 그 사람과 이미 만들어 둔 1:1 채팅방(열린 창이나 채팅 목록)으로 보낸다.
# 보낼 창을 얻지 못하면 아무 글도 보내지 않고 사유를 돌려준다. dry면 1:1 채팅 창을 여는 데까지만 한다.
function Cmd-Direct([string]$room, [string]$text, [string]$rowText, [bool]$dry) {
  $msgs = @(Read-Messages (Get-RoomWindow $room))
  # 마지막 12개에서 본문이 같은 일감 글을 아래에서부터 찾는다
  $row = $null
  for ($i = $msgs.Count - 1; $i -ge [Math]::Max(0, $msgs.Count - 12) -and -not $row; $i--) {
    if ((Squash $msgs[$i].text) -eq (Squash $rowText)) { $row = $msgs[$i] }
  }
  if (-not $row) { throw '일감 글을 다시 찾지 못했습니다.' }
  if (-not $row.sender) { throw '내가 올린 글이라 보내지 않았습니다.' }
  if ($row.sender -eq '?') { throw '글 올린 사람 이름이 화면 밖에 있어 읽지 못했습니다.' }
  $sender = $row.sender
  $chat = Open-ExistingChat $sender
  if (-not $chat) { throw "`"$sender`"님과 만들어 둔 1:1 채팅방을 찾지 못했습니다(윈도우에서는 이미 대화한 적 있는 사람에게만 보낼 수 있습니다)." }
  # 열린 창이 지켜보는 방 자체라면 잘못 보내는 것이므로 멈춘다
  if ($chat.Win.Name -eq $room) { throw '1:1 채팅 창이 아니라 지켜보는 방이 열려 보내지 않았습니다.' }
  try {
    if ($dry) { return @{ sent = $false; opened = $true; to = $sender; via = 'list' } }
    $out = Send-To $chat.Win $text
    @{ sent = $out.sent; to = $sender; via = 'list' }
  } finally {
    # 이번에 새로 연 창이면 닫아서 화면을 원래대로 둔다
    if (-not $chat.WasOpen) { [void][KakaoWin]::PostMessage($chat.Win.Hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
  }
}

try {
  switch ($Cmd) {
    'rooms' { Out-Json (Cmd-Rooms) }
    'peek' { Out-Json (Cmd-Peek $Room) }
    'send' { Out-Json (Send-To (Get-RoomWindow $Room) $Text) }
    'direct' { Out-Json (Cmd-Direct $Room $Text $RowText ($Flag -eq 'dry')) }
    default { Out-Json @{ error = "알 수 없는 명령: $Cmd" } }
  }
} catch {
  Out-Json @{ error = [string]$_.Exception.Message }
}
