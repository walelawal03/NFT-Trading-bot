@echo off
cd /d "%~dp0"
echo Live NFT bot logs - close this window to stop watching.
echo.
call pm2 logs nftbot --lines 40
