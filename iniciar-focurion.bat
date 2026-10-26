@echo off
chcp 65001 > nul
title Focurion MySQL
cd /d "%~dp0"

where node > nul 2>&1
if errorlevel 1 (
  echo Node.js no esta instalado. Instala Node.js 18 o posterior y vuelve a intentarlo.
  pause
  exit /b 1
)

if not exist .env (
  copy .env.example .env > nul
  echo Se creo el archivo .env con la configuracion local de XAMPP.
)

if not exist node_modules (
  echo Instalando dependencias...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

echo.
echo Verifica que MySQL este iniciado en XAMPP. Focurion probara los puertos 3306 y 3307.
echo Iniciando Focurion en http://localhost:3000
call npm.cmd start
pause
