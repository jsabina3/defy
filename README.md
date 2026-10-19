# Incógnito · Viajes sorpresa premium

Web de reserva de viajes sorpresa (estilo Waynabox, pero con superpoderes):

- **Cuestionario de preferencias antes del calendario** → la IA personaliza **precios** y **destinos**.
- **Vuelo + hotel** incluidos, con opción de **actividades sorpresa en 2 niveles** (Esencia / Inmersión), con comparativa de valor de mercado vs precio del pack y margen de actividades.
- **Joyas escondidas**: destinos que requieren volar + 1–2 h en coche/tren/ferry (Positano, Lago de Como, Hallstatt, Cinque Terre…).
- **Escapadas cortas** (2–4 días) y mucho peso visual (vídeo en el hero).
- Al final del proceso (sin pago) se revela el **vuelo y hotel asignados** y el **margen** que sacaríamos.
- **Pasaporte Defy**: cuentas de usuario con un programa de recompensas (millas + niveles + canje). Ver abajo.

## Pasaporte Defy (cuentas + recompensas)

Sistema de cuentas sin base de datos ni dependencias externas: las cuentas se guardan
en un único `data/accounts.json` y solo se usan módulos nativos de Node (`crypto` para
hashing **scrypt** de contraseñas y tokens de sesión). La sesión viaja en una **cookie
httpOnly** (`defy_session`).

Diseño del programa (alineado con buenas prácticas de loyalty 2026: progreso visible,
pocos niveles claros, quick win de bienvenida, recompensas sorpresa, canje flexible):

- **Millas**: ganas 1 milla por cada 1 € de viaje pre-reservado (× multiplicador del nivel) y **500 de bienvenida** al registrarte.
- **Niveles** (según millas ganadas de por vida; canjear nunca te baja de nivel): 🧭 Curioso → 🗺️ Explorador (1.500) → ⛰️ Aventurero (5.000) → 👑 Leyenda (12.000). Cada nivel sube el multiplicador de millas y los descartes gratis.
- **Canje** (`/cuenta`): descarte extra gratis, 30 € de descuento, upgrade de alojamiento y experiencia sorpresa. Cada canje genera un voucher con código.
- El widget de cuenta aparece en la barra de todas las páginas; al confirmar una pre-reserva se suman las millas (pide registro si no hay sesión).

## Stack

- **Backend:** Node + Express (`server.js`). Elige destinos y estima precios con OpenAI, con **fallback determinista** para que funcione sin IA.
- **Precios reales (opcional):** RouteStack (`src/routestack.js`) consulta vuelos y hoteles en vivo por MCP y guarda las referencias del inventario (aeropuertos, id de destino, id de hotel, correlación de la búsqueda). Si no hay credenciales de RouteStack, se usa Amadeus Self-Service (`src/amadeus.js`). Si tampoco hay datos, se vuelve a la estimación.
- **Imágenes (opcional):** Unsplash (`src/images.js`) para fotos de alta calidad por destino; sin clave cae a LoremFlickr en alta resolución. Las fotos locales curadas (`/assets`) tienen prioridad.
- **Frontend:** HTML + CSS + JS vanilla en `/public` (sin build step).
- **Datos:** catálogo curado de destinos y tiers en `src/catalog.js`.

## Ejecutar en local

> Requiere Node 18.17+.

```bash
npm install
# crea tu .env a partir del ejemplo
copy .env.example .env   # Windows
# cp .env.example .env    # macOS/Linux
npm start
```

Abre http://localhost:3000

## Variables de entorno

| Variable                | Obligatoria | Descripción                                                        |
| ----------------------- | ----------- | ------------------------------------------------------------------ |
| `OPENAI_API_KEY`        | Sí (IA)     | Clave de OpenAI. Si falta, usa el fallback determinista.           |
| `OPENAI_MODEL`          | No          | Modelo a usar (por defecto `gpt-5.4-mini`).                        |
| `ROUTESTACK_API_KEY`    | No          | RouteStack. Precios reales y referencias de vuelo/hotel. Tiene prioridad sobre Amadeus. |
| `ROUTESTACK_API_SECRET` | No          | Secreto para el partner-token (HMAC).                             |
| `ROUTESTACK_MCP_URL`    | No          | Endpoint MCP. Por defecto `https://mcp.routestack.ai/mcp`.         |
| `ROUTESTACK_ACCOUNT_ID` | No          | Id de cuenta (informativo).                                        |
| `AMADEUS_CLIENT_ID`     | No          | Amadeus Self-Service. Respaldo si no hay RouteStack.               |
| `AMADEUS_CLIENT_SECRET` | No          | Secreto de Amadeus.                                                |
| `AMADEUS_ENV`           | No          | `test` (gratis) o `production`. Por defecto `test`.                |
| `UNSPLASH_ACCESS_KEY`   | No          | Unsplash. Activa fotos de alta calidad (fallback: LoremFlickr).    |
| `ACCOUNTS_DIR`          | No          | Carpeta donde guardar `accounts.json` (Pasaporte Defy). Por defecto `./data`. En Railway, apúntala a un volumen para que las cuentas persistan entre deploys (no uses la carpeta del volumen de imágenes: se sirve por HTTP). |
| `PORT`                  | No          | Puerto (Railway lo inyecta automáticamente).                       |

## Desplegar en Railway

1. Sube el repo a GitHub (el `.gitignore` ya excluye `.env` y `node_modules`).
2. En Railway: **New Project → Deploy from GitHub repo**.
3. En **Variables**, añade `OPENAI_API_KEY` (y opcionalmente `OPENAI_MODEL`, `ROUTESTACK_API_KEY`, `ROUTESTACK_API_SECRET`, `ROUTESTACK_MCP_URL`, `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_ENV`, `UNSPLASH_ACCESS_KEY`).
4. Railway detecta Node, ejecuta `npm install` y `npm start`. No toques `PORT`.

## Endpoints

- `POST /api/quote` — recibe preferencias, devuelve destinos + parámetros de precio.
- `POST /api/checkout` — revela vuelo, hotel, destino asignado y el margen.
- `GET /api/health` — estado y proveedores activos (IA, Amadeus, Unsplash).
- `POST /api/auth/register` · `POST /api/auth/login` · `POST /api/auth/logout` — cuentas (cookie de sesión).
- `GET /api/auth/me` — usuario actual + catálogo de niveles y recompensas.
- `POST /api/rewards/earn` — suma millas por una pre-reserva (requiere sesión).
- `POST /api/rewards/redeem` — canjea una recompensa por millas (requiere sesión).

## Notas

- Sin RouteStack ni Amadeus, los precios son **estimaciones** (IA + motor de markups). Con RouteStack, el precio de la fecha elegida y las referencias de vuelo/hotel salen del inventario en vivo; el calendario usa una cotización de referencia y la estacionalidad solo modula las fechas aún no cotizadas. Amadeus hace lo mismo si RouteStack no está configurado. En ningún caso son reservas reales.
- Persistencia ligera por fichero (`data/accounts.json`) solo para las cuentas del Pasaporte Defy; el resto del flujo de cotización sigue sin estado. No hay reservas reales ni cobros.
- **Seguridad:** la `OPENAI_API_KEY` solo se usa en el servidor; nunca llega al navegador. Las contraseñas se guardan con hash **scrypt** + salt y la sesión va en cookie httpOnly; `data/` está en `.gitignore`.
