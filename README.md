# Laboratorio de Bolsillo

App móvil de código abierto que convierte el móvil en un conjunto de instrumentos
científicos usando la cámara, el micrófono y el resto de sensores.
Todo funciona sin conexión y en el propio dispositivo: sin analítica ni rastreo.

Idiomas: castellano y euskera. Licencia: [GPL-3.0-or-later](LICENSE).

La única conexión a Internet es la búsqueda **manual** de actualizaciones, que consulta las
[Releases de este repositorio](https://github.com/JosuIru/laboratorio-de-bolsillo/releases).
Para publicar una versión, consulta [RELEASING.md](RELEASING.md). Para crear instrumentos,
[CONTRIBUTING.md](CONTRIBUTING.md).

## Instrumentos

- **Analizador de espectro**: FFT del micrófono en tiempo real, espectrograma en cascada,
  frecuencia dominante con nota musical y nivel (dBFS, o dB aproximados si se calibra con un
  sonómetro).
- **Sismógrafo**: aceleración de los tres ejes sin la gravedad, espectro de la vibración,
  frecuencia dominante, pico, valor eficaz y contador de eventos. Guarda la serie cruda en CSV.
- **Colorímetro**: color de una zona de la imagen en CIELAB, corregido con una tarjeta de
  referencia en el mismo encuadre, y comparación por ΔE2000 con escalas definidas por el
  usuario (p. ej. tiras reactivas).

Todas las mediciones se guardan en el móvil y se pueden exportar a CSV o JSON.

## Requisitos

- Node 24 (`nvm use`, ver `.nvmrc`); Expo SDK 57 exige Node ≥ 22.13
- JDK 17 o superior y el SDK de Android (`ANDROID_HOME`)
- Un móvil Android con la depuración USB activada

La app usa módulos nativos, así que **no funciona con Expo Go**: hay que usar un
*development build*.

## Puesta en marcha

```bash
nvm use
npm install
npm run android      # compila el dev build, lo instala en el móvil y arranca Metro
```

Después de la primera instalación basta con `npm start` para arrancar Metro.
Si cambias dependencias nativas o `app.json`, regenera el proyecto nativo con
`npm run prebuild` y vuelve a ejecutar `npm run android`.

## Comprobaciones

```bash
npm test             # Jest
npm run typecheck    # TypeScript estricto
npm run lint         # ESLint
npm run doctor       # expo-doctor
```

## Estructura

```
src/app/          rutas de expo-router
src/core/         núcleo: sensores, instrumentos, mediciones, calibración, i18n…
src/processing/   procesamiento puro en TypeScript (FFT, color…) con tests
src/ui/           componentes compartidos y gráficas
instruments/      un instrumento por carpeta + registry.ts
```
