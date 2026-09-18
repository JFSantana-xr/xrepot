# Xrepot — modo mantenimiento

Sitio de mantenimiento con anuncios públicos y un panel privado en `/ad`.

## Arranque

1. Copia `.env.example` a `.env` y completa los tres secretos.
2. Ejecuta `npm start` (no necesita dependencias externas).

En la primera ejecución se crea la cuenta indicada por `ADMIN_EMAIL` y `ADMIN_PASSWORD`. Después puedes crear más cuentas desde **Administradores** dentro del panel. La base de datos se guarda en `data/xrepot.json`; no se publica ni se versiona.

Los anuncios admiten una imagen opcional JPG, PNG, WEBP o GIF de hasta 2 MB. Las imágenes se guardan en `public/uploads/`, se publican con una URL inmutable y se eliminan al borrar el anuncio.

La web pública y el panel se actualizan en tiempo real mediante Server-Sent Events: un cambio hecho por un administrador llega al resto de las sesiones abiertas sin recargar. Los archivos estáticos y las imágenes usan caché de larga duración; el estado dinámico usa ETag y no se queda obsoleto.

## Google AdSense

En AdSense crea una unidad publicitaria y copia sus valores en el entorno de producción:

```env
ADSENSE_CLIENT=ca-pub-tu-identificador
ADSENSE_SLOT=tu-identificador-de-unidad
```

El bloque se muestra en la esquina superior derecha únicamente cuando ambas variables son válidas. Google debe aprobar el sitio y la unidad antes de que entregue anuncios.

## Producción

Configura `NODE_ENV=production`, usa HTTPS mediante tu proxy/reverse proxy y define secretos únicos. No expongas el puerto de Node directamente a Internet si tu plataforma ya provee un proxy.

Para una multitud de visitantes, coloca CDN/proxy delante de Node y habilita conexiones persistentes sin búfer para `/api/public/events` y `/api/ad/events`. Este proyecto usa un archivo local y conexiones SSE en memoria, por lo que para escalar horizontalmente entre varias instancias hay que migrar los datos a PostgreSQL (o similar), las imágenes a almacenamiento de objetos y retransmitir cambios con Redis Pub/Sub. Así todas las instancias comparten sesiones, datos y eventos.
