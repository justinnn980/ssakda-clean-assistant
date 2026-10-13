-- 싹다클린 AI 비서: 두 번 누르면 켜고, 켜져 있으면 열기·끄기를 고른다
-- 프로그램 폴더(아이콘을 만들 때 install-launcher.sh가 실제 위치로 바꿔 넣는다), 화면 주소, 창 제목
property appDir : "__APP_DIR__"
property appUrl : "http://localhost:3210"
property appTitle : "싹다클린 AI 비서"

-- 프로그램이 켜져 있는지 확인한다: 화면 주소를 2초 안에 불러 봐서 정상 응답(200)이 오면 켜져 있는 것
on isRunning()
	try
		return (do shell script "curl -s -o /dev/null -m 2 -w '%{http_code}' " & appUrl & "/") is "200"
	on error
		return false
	end try
end isRunning

-- .env 파일에서 접속 비밀번호를 읽는다. 읽지 못하면 빈 글자
on readPin()
	try
		return do shell script "grep '^ACCESS_PIN=' " & quoted form of (appDir & "/.env") & " | cut -d= -f2"
	on error
		return ""
	end try
end readPin

-- 켜져 있으면 비밀번호를 보여주고 '화면 열기', '끄기', '닫기' 중에서 고르게 한다
if isRunning() then
	set answer to button returned of (display dialog "지금 켜져 있습니다." & return & return & "접속 비밀번호: " & readPin() buttons {"끄기", "닫기", "화면 열기"} default button "화면 열기" cancel button "닫기" with title appTitle)
	if answer is "화면 열기" then
		-- 화면 열기: 브라우저로 연다
		open location appUrl
	else if answer is "끄기" then
		-- 끄기: stop.sh를 실행하고 껐다고 알린다
		do shell script quoted form of (appDir & "/stop.sh")
		display dialog "껐습니다." & return & return & "다시 켜려면 이 아이콘을 두 번 누르세요." buttons {"확인"} default button "확인" with title appTitle
	end if
else
	-- 꺼져 있으면 start.sh를 뒤에서 실행하고(기록은 data/server.log에 남는다) 켜질 때까지 1초 간격으로 20번까지 확인한다
	do shell script "cd " & quoted form of appDir & " && mkdir -p data && (nohup ./start.sh > data/server.log 2>&1 &)"
	set started to false
	repeat 20 times
		delay 1
		if isRunning() then
			set started to true
			exit repeat
		end if
	end repeat
	-- 켜졌으면 비밀번호를 보여주고 화면을 열지 묻는다. 켜지지 않았으면 어떻게 할지 알려준다
	if started then
		set answer to button returned of (display dialog "켜졌습니다." & return & return & "접속 비밀번호: " & readPin() & return & return & "노트북 덮개를 닫으면 멈추니 열어 두세요." buttons {"닫기", "화면 열기"} default button "화면 열기" cancel button "닫기" with title appTitle)
		if answer is "화면 열기" then open location appUrl
	else
		display dialog "켜지지 않았습니다." & return & return & "노트북을 다시 시작한 뒤 한 번 더 눌러 보세요. 그래도 안 되면 도움을 요청해 주세요." buttons {"확인"} default button "확인" with title appTitle with icon caution
	end if
end if
