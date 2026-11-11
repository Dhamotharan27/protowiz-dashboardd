@echo off
set "LNK=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\iBots Project Management.lnk"
powershell -NoProfile -Command "$w=New-Object -ComObject WScript.Shell; $l=$w.CreateShortcut($env:LNK); $l.TargetPath='%~dp0start.bat'; $l.WorkingDirectory='%~dp0'; $l.WindowStyle=7; $l.Save()"
echo Done. iBots Project Management will now start automatically when you log in to Windows.
echo To turn this off, run autostart-off.bat
pause
