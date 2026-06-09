# Incógnito · Viajes sorpresa premium

Web de reserva de viajes sorpresa (estilo Waynabox, pero con superpoderes):

- **Cuestionario de preferencias antes del calendario** → la IA personaliza **precios** y **destinos**.
- **Vuelo + hotel** incluidos, con opción de **actividades sorpresa en 2 niveles** (Esencia / Inmersión), con comparativa de valor de mercado vs precio del pack y margen de actividades.
- **Joyas escondidas**: destinos que requieren volar + 1–2 h en coche/tren/ferry (Positano, Lago de Como, Hallstatt, Cinque Terre…).
- **Escapadas cortas** (2–4 días) y mucho peso visual (vídeo en el hero).
- Al final del proceso (sin pago) se revela el **vuelo y hotel asignados** y el **margen** que sacaríamos.

## Stack

- **Backend:** Node + Express (`server.js`). Elige destinos y estima precios con OpenAI, con **fallback determinista** para que funcione sin IA.
- **Precios reales (opcional):** Amadeus Self-Service (`src/amadeus.js`) sustituye las estimaciones de vuelo/hotel por precios reales cuando hay credenciales; si faltan o el destino no tiene datos, vuelve a la estimación.
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
| `AMADEUS_CLIENT_ID`     | No          | Amadeus Self-Service. Activa precios reales de vuelos/hoteles.     |
| `AMADEUS_CLIENT_SECRET` | No          | Secreto de Amadeus.                                                |
| `AMADEUS_ENV`           | No          | `test` (gratis) o `production`. Por defecto `test`.                |
| `UNSPLASH_ACCESS_KEY`   | No          | Unsplash. Activa fotos de alta calidad (fallback: LoremFlickr).    |
| `PORT`                  | No          | Puerto (Railway lo inyecta automáticamente).                       |

## Desplegar en Railway

1. Sube el repo a GitHub (el `.gitignore` ya excluye `.env` y `node_modules`).
2. En Railway: **New Project → Deploy from GitHub repo**.
3. En **Variables**, añade `OPENAI_API_KEY` (y opcionalmente `OPENAI_MODEL`, `AMADEUS_CLIENT_ID`, `AMADEUS_CLIENT_SECRET`, `AMADEUS_ENV`, `UNSPLASH_ACCESS_KEY`).
4. Railway detecta Node, ejecuta `npm install` y `npm start`. No toques `PORT`.

## Endpoints

- `POST /api/quote` — recibe preferencias, devuelve destinos + parámetros de precio.
- `POST /api/checkout` — revela vuelo, hotel, destino asignado y el margen.
- `GET /api/health` — estado y proveedores activos (IA, Amadeus, Unsplash).

## Notas

- Sin Amadeus, los precios son **estimaciones** (IA + motor de markups). Con Amadeus, el precio base de vuelo/hotel es **real** y la estacionalidad lo modula por fecha. En ningún caso son reservas reales.
- Sin base de datos: no se guardan clientes ni clics (pendiente, según lo acordado).
- **Seguridad:** la `OPENAI_API_KEY` solo se usa en el servidor; nunca llega al navegador.
