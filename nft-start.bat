@echo off
cd /d "%~dp0"
echo Starting NFT Mint Underwriter...
call pm2 start nftbot 2>nul || call pm2 start src/index.js --name nftbot --cwd "%~dp0" --time
call pm2 save
echo.
echo Bot STARTED. Runs in the background and auto-starts when you log in.
echo This is SEPARATE from degenbot - stopping one does not stop the other.
pause
