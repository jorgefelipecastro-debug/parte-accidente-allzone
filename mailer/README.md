# Servicio de correo del Parte de Accidente

El Worker `parte-accidente-mailer` se compila desde el directorio `mailer` con `npx wrangler deploy --config wrangler.toml`, usando la rama `correo-respaldo-cloudflare-brevo`. No cambiar `main` para iniciar una compilación.

Configurar en el Worker los secretos `BREVO_API_KEY` y `TURNSTILE_SECRET`, y la variable `BREVO_SENDER` con el remitente verificado. No guardar claves en Git ni en el navegador de la aplicación. `RATE_LIMITER` se declara en Wrangler.

Comprobar primero la respuesta de `/send-accident-report` con el origen de la aplicación. Mantener desactivada la integración en la aplicación pública hasta verificar un correo de prueba con un PDF ficticio en los dos buzones acordados. `node mailer/audit.mjs` ejecuta las pruebas simuladas sin mandar correos.
