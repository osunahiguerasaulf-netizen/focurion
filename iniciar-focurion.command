#!/bin/bash

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js no está instalado. Instala Node.js 18 o posterior y vuelve a intentarlo."
  read -r -p "Presiona Enter para cerrar…"
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Se creó el archivo .env con la configuración local de XAMPP."
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependencias…"
  npm install || {
    echo "No se pudieron instalar las dependencias."
    read -r -p "Presiona Enter para cerrar…"
    exit 1
  }
fi

echo
echo "Verifica que MySQL esté iniciado en XAMPP. Focurion probará los puertos 3306 y 3307."
echo "Abre http://localhost:3000 cuando el servidor esté listo."
npm start

read -r -p "Presiona Enter para cerrar…"
