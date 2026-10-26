# Focurion – versión preparada para hosting

Esta copia conserva el modo local con XAMPP y agrega compatibilidad con MySQL remoto.

## Lo que ya quedó preparado

- Usa `PORT` del proveedor de hosting.
- En producción confía en el proxy para que las cookies seguras de sesión funcionen por HTTPS.
- Acepta MySQL remoto mediante `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` y `DB_NAME`.
- Soporta MySQL con SSL mediante `DB_SSL=true`.
- En MySQL remoto NO intenta crear la base de datos; se conecta a la base que cree el proveedor y Focurion crea sus tablas automáticamente.
- En local/XAMPP sigue probando 3306 y 3307 y puede crear `focurion` automáticamente.
- Incluye `/api/health` para comprobar servidor + base de datos.
- Incluye `render.yaml` como plantilla de despliegue.
- `.env` está ignorado por Git y NO debe subirse a un repositorio público.

## Para subirlo a internet

1. Crea una base MySQL pública/gestionada y copia sus datos de conexión.
2. Sube ESTA carpeta a un repositorio de GitHub. No subas `.env`.
3. Crea un Web Service de Node en tu plataforma de hosting conectando el repositorio.
4. Build command: `npm ci`
5. Start command: `npm start`
6. Agrega estas variables de entorno:

   - `NODE_ENV=production`
   - `SESSION_SECRET=` una cadena larga y aleatoria
   - `DB_HOST=` host de tu MySQL
   - `DB_PORT=` puerto de tu MySQL
   - `DB_USER=` usuario de tu MySQL
   - `DB_PASSWORD=` contraseña de tu MySQL
   - `DB_NAME=` nombre exacto de la base creada por el proveedor
   - `DB_SSL=true` si tu proveedor exige SSL; de lo contrario `false`
   - `DB_SSL_REJECT_UNAUTHORIZED=true` normalmente; usa `false` solo si tu proveedor lo exige expresamente

7. Cuando el despliegue termine, abre:

   `https://TU-DOMINIO/api/health`

   Debe responder JSON con `"ok": true` y el nombre de la base.

8. Abre el dominio principal y prueba registro, inicio de sesión, tareas y comunidades.
9. Usa el dominio HTTPS final como destino del QR del cartel.

## Modo local

Copia `.env.example` como `.env`, deja `DB_HOST=127.0.0.1` y arranca MySQL en XAMPP. Después ejecuta:

```bash
npm install
npm start
```

## Importante

La versión actual usa el almacenamiento de sesiones en memoria de Express. Es suficiente para una demostración académica con una sola instancia, pero si después lo convierten en servicio permanente conviene mover las sesiones a un almacén persistente.
