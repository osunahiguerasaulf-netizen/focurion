# Focurion 2.1.1 — Node.js + Express + MySQL (XAMPP)

Focurion es una plataforma académica local con panel estudiantil, salas colaborativas, comunidades, calendario, Pomodoro, ranking y panel administrativo. Esta entrega está preparada para XAMPP en Windows y macOS.

## Requisitos

- Node.js 18 o posterior.
- XAMPP con el servicio **MySQL** iniciado.
- Un navegador moderno.

Apache no es obligatorio: Focurion usa Node.js para servir la aplicación. Puedes iniciar Apache si también quieres utilizar phpMyAdmin.

## Inicio rápido en Windows

1. Descomprime `Focurion-MySQL.zip`.
2. Abre XAMPP Control Panel y presiona **Start** en MySQL.
3. Haz doble clic en `iniciar-focurion.bat`.
4. Cuando la terminal indique que el servidor está listo, abre [http://localhost:3000](http://localhost:3000).

También puedes iniciarlo manualmente desde PowerShell o CMD:

```powershell
Copy-Item .env.example .env
npm.cmd install
npm.cmd start
```

## Inicio rápido en macOS

1. Descomprime `Focurion-MySQL.zip`.
2. Abre XAMPP y activa **MySQL Database**.
3. Haz doble clic en `iniciar-focurion.command`.
4. Si macOS bloquea el archivo la primera vez, abre Terminal en la carpeta del proyecto y ejecuta:

```bash
chmod +x iniciar-focurion.command
./iniciar-focurion.command
```

También puedes iniciarlo manualmente:

```bash
cp .env.example .env
npm install
npm start
```

Después abre [http://localhost:3000](http://localhost:3000).

## Conexión con MySQL

La configuración inicial usa:

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=focurion
```

Focurion prueba automáticamente los puertos `3306` y `3307`, por lo que funciona con las configuraciones más comunes de XAMPP en Windows y macOS. Si tu instalación usa contraseña u otro puerto, edita `.env`.

Al iniciar, el servidor crea la base, sus tablas y el contenido inicial. También:

- mantiene las fechas de demostración próximas al día actual;
- completa comunidades vacías con publicaciones, recursos, proyecto y reto iniciales;
- mantiene varias publicaciones y comentarios iniciales en cada comunidad, sin duplicarlos;
- integra a cuentas activas sin comunidad en la comunidad inicial;
- evita duplicar ese contenido en arranques posteriores.

Las publicaciones permiten comentar, marcar **Me gusta** y guardar contenido. Las reacciones se almacenan en MySQL por usuario y conservan su estado al volver a entrar.

El archivo `database/schema.sql` permite crear solamente la estructura desde phpMyAdmin si lo necesitas.

## Cuentas de prueba

Administrador:

```text
admin@focurion.local
Admin123!
```

Estudiante:

```text
alumno@focurion.local
Demo123!
```

## Respaldo administrativo

Entra como administrador y abre **Configuración → Respaldo de datos → Descargar respaldo**. Se descargará un JSON con usuarios, tareas, calendario, comunidades, publicaciones, recursos, salas y actividad.

Por seguridad, el archivo no incluye contraseñas ni códigos de recuperación. Conserva el respaldo en un lugar seguro.

## Recuperar contraseña

En el inicio de sesión selecciona **¿Olvidaste tu contraseña?**, escribe el correo, captura el código de seis dígitos y establece una nueva contraseña.

- Sin SMTP configurado, el código aparece en la pantalla y en la terminal del servidor local.
- Para enviarlo por correo, completa las variables `SMTP_*` de `.env`.
- Cada código vence a los 15 minutos y se usa una sola vez.

## Verificación técnica

Antes de entregar o mover el proyecto puedes revisar la sintaxis principal con:

```bash
npm run check
```

## Solución de problemas

### `Cannot find module 'express'`

Ejecuta `npm install` en macOS o `npm.cmd install` en Windows.

### PowerShell bloquea `npm.ps1`

Usa `npm.cmd install` y `npm.cmd start`.

### No se puede conectar con MySQL

Comprueba que MySQL esté activo en XAMPP. Focurion probará `3306` y `3307`; si usas otro puerto o contraseña, actualiza `.env`.

### El puerto 3000 está ocupado

Cambia `PORT=3000` en `.env`, por ejemplo a `PORT=3001`, y abre la URL correspondiente.

## Estructura principal

```text
Focurion-MySQL/
├─ database/schema.sql
├─ public/
│  ├─ assets/
│  ├─ css/styles.css
│  ├─ js/
│  ├─ app.html
│  └─ index.html
├─ scripts/check.js
├─ .env.example
├─ iniciar-focurion.bat
├─ iniciar-focurion.command
├─ package.json
└─ server.js
```
