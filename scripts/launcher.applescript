-- 싹다클린 AI 비서: 두 번 누르면 켜고, 켜져 있으면 열기·끄기를 고른다
property appDir : "__APP_DIR__"
property appUrl : "http://localhost:3210"
property appTitle : "싹다클린 AI 비서"

on isRunning()
	try
		return (do shell script "curl -s -o /dev/null -m 2 -w '%{http_code}' " & appUrl & "/") is "200"
	on error
		return false
	end try
end isRunning

on readPin()
	try
		return do shell script "grep '^ACCESS_PIN=' " & quoted form of (appDir & "/.env") & " | cut -d= -f2"
	on error
		return ""
	end try
end readPin

if isRunning() then
	set answer to button returned of (display dialog "지금 켜져 있습니다." & return & return & "접속 비밀번호: " & readPin() buttons {"끄기", "닫기", "화면 열기"} default button "화면 열기" cancel button "닫기" with title appTitle)
	if answer is "화면 열기" then
		open location appUrl
	else if answer is "끄기" then
		do shell script quoted form of (appDir & "/stop.sh")
		display dialog "껐습니다." & return & return & "다시 켜려면 이 아이콘을 두 번 누르세요." buttons {"확인"} default button "확인" with title appTitle
	end if
else
	do shell script "cd " & quoted form of appDir & " && mkdir -p data && (nohup ./start.sh > data/server.log 2>&1 &)"
	set started to false
	repeat 20 times
		delay 1
		if isRunning() then
			set started to true
			exit repeat
		end if
	end repeat
	if started then
		set answer to button returned of (display dialog "켜졌습니다." & return & return & "접속 비밀번호: " & readPin() & return & return & "노트북 덮개를 닫으면 멈추니 열어 두세요." buttons {"닫기", "화면 열기"} default button "화면 열기" cancel button "닫기" with title appTitle)
		if answer is "화면 열기" then open location appUrl
	else
		display dialog "켜지지 않았습니다." & return & return & "노트북을 다시 시작한 뒤 한 번 더 눌러 보세요. 그래도 안 되면 도움을 요청해 주세요." buttons {"확인"} default button "확인" with title appTitle with icon caution
	end if
end if
