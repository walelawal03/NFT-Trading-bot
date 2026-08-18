@echo off
cd /d "%~dp0"
echo Stopping NFT Mint Underwriter...
call pm2 stop nftbot
call pm2 save
echo.
echo Bot STOPPED. Stays off (even after reboot) until you run nft-start.bat
echo NOTE: while it is off it records nothing, and the 7d/30d outcome
echo horizons can only settle for calls that were actually recorded.
pause
