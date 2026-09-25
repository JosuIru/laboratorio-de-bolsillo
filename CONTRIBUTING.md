# Cómo contribuir a Laboratorio de Bolsillo

Gracias por querer mejorar el laboratorio. Este documento explica cómo preparar el
entorno y, sobre todo, **cómo crear un instrumento nuevo** paso a paso.

- [Preparar el entorno](#preparar-el-entorno)
- [Principios del proyecto](#principios-del-proyecto)
- [Crear un instrumento nuevo](#crear-un-instrumento-nuevo)
- [Antes de abrir un pull request](#antes-de-abrir-un-pull-request)

## Preparar el entorno

Sigue el [README](README.md). En resumen: Node 24 (`nvm use`), SDK de Android, un móvil
Android con depuración USB y `npm run android`. La app usa módulos nativos, así que
**no funciona con Expo Go**.

## Principios del proyecto

1. **Privacidad.** Todo funciona sin conexión y los datos no salen del móvil salvo que el
   usuario exporte. No añadas analítica, rastreo ni llamadas de red.
2. **Procesamiento puro y con tests.** FFT, filtros, conversiones de color… van en
   `src/processing/` como funciones TypeScript sin React ni React Native, con tests en Jest.
3. **Nada pesado en el hilo de la interfaz.** El procesamiento de audio y cámara en tiempo
   real va en worklets (`react-native-worklets`) o en código nativo.
4. **Bilingüe desde el principio.** Todo texto visible tiene versión en castellano (`es`) y
   en euskera (`eu`). Si no sabes euskera, deja la traducción al castellano y avísalo en el
   pull request: alguien la revisará.
5. **Nombres descriptivos.** `peakAccelerationMetersPerSecondSquared` mejor que `pa`.
6. **Dependencias.** Instala siempre con `npx expo install` (elige versiones compatibles con
   el SDK). Consulta antes de añadir dependencias grandes.

## Crear un instrumento nuevo

Un instrumento es **una carpeta en `instruments/` y una línea en `instruments/registry.ts`**.
El núcleo se encarga del resto: la tarjeta en la pantalla de inicio, los permisos, la
pantalla deshabilitada si faltan sensores, el historial, la exportación a CSV y JSON, la
ubicación opcional y los perfiles de calibración.

El instrumento de referencia es **`instruments/example-level/`**, un nivel de burbuja que
solo aparece en builds de desarrollo. Cópialo como plantilla.

### 1. Crea la carpeta

```
instruments/mi-instrumento/
├── index.ts               # la definición (InstrumentDefinition)
├── schema.ts              # qué datos guarda cada medición
├── Screen.tsx             # la pantalla del instrumento
├── calibration.ts         # (opcional) parámetros de calibración y su validación
├── CalibrationScreen.tsx  # (opcional) pantalla para calibrar
├── calibration.test.ts    # tests de la lógica propia del instrumento
└── locales/
    ├── es.json
    └── eu.json
```

El id del instrumento (`mi-instrumento`) va en *kebab-case* y **no debe cambiar nunca**,
porque se guarda en cada medición.

### 2. Define el esquema de datos (`schema.ts`)

El esquema dice qué valores guarda cada medición. El núcleo lo usa para validar antes de
guardar, para las columnas del CSV y para mostrar el historial.

```ts
import { defineMeasurementSchema } from '@/core/measurements/schema';

export interface VibrationMeasurementValues {
  dominantFrequencyHz: number;
  peakAccelerationMetersPerSecondSquared: number;
  spectrum: number[];
  note?: string;
}

export const vibrationSchema = defineMeasurementSchema<VibrationMeasurementValues>(1, [
  { key: 'dominantFrequencyHz', labelKey: 'fields.frequency', type: 'number', unit: 'Hz' },
  { key: 'peakAccelerationMetersPerSecondSquared', labelKey: 'fields.peak', type: 'number', unit: 'm/s²' },
  { key: 'spectrum', labelKey: 'fields.spectrum', type: 'numberArray' },
  { key: 'note', labelKey: 'fields.note', type: 'string', optional: true },
]);
```

- Tipos de campo: `number`, `string`, `boolean`, `numberArray` (acepta `Float32Array`) y
  `color` (`#RRGGBB`).
- Usa unidades del SI siempre que puedas.
- **Si cambias la forma de los datos, sube la versión** (el primer argumento). Cada medición
  guarda la versión con la que se creó.
- Los datos muy grandes (series de miles de muestras, audio, fotos) no van en `values`:
  guárdalos como **adjuntos** (ver el paso 4).

### 3. Escribe el procesamiento como funciones puras

Si tu instrumento calcula algo, hazlo en funciones puras en `src/processing/` (si otros
instrumentos pueden reutilizarlas) o en tu carpeta (si son solo tuyas), y escribe tests:

```ts
// src/processing/signal/orientation.ts
export function tiltAnglesFromGravity(gravity: GravityVector): TiltAngles {
  'worklet';
  // …
}
```

La directiva `'worklet'` permite ejecutar la función también dentro de un worklet (hilo de
cámara o de audio) sin cambiar nada. En Jest se ejecuta como una función normal.

### 4. Escribe la pantalla (`Screen.tsx`)

La pantalla recibe estas props del núcleo (`InstrumentScreenProps`):

| Prop | Para qué |
|---|---|
| `instrumentId` | El id de tu instrumento. |
| `calibrationParameters` | Parámetros de la calibración activa o, si no hay ninguna, los de por defecto. |
| `activeCalibrationProfile` | El perfil activo, o `null`. |
| `saveMeasurement(draft)` | Valida, añade fecha, id y ubicación (si el usuario lo activó) y guarda. |
| `sensorAvailability` | Estado de todos los sensores, para activar funciones opcionales. |

Cuando la pantalla se monta, los sensores obligatorios ya están disponibles y con permiso.

```tsx
export function VibrationScreen({ saveMeasurement }: InstrumentScreenProps<VibrationMeasurementValues>) {
  const { t } = useTranslation('mi-instrumento'); // tu espacio de nombres i18n

  useSensorSubscription(accelerometerSource, (sample) => {
    // sample.value está en m/s²; sample.timestampSeconds es monotónico
  }, { targetRateHz: 100 });

  async function handleSave() {
    await saveMeasurement({
      values: { dominantFrequencyHz, peakAccelerationMetersPerSecondSquared, spectrum },
      attachments: [
        { kind: 'series', sourceUri: temporaryFile.uri, fileName: 'raw.bin', mimeType: 'application/octet-stream' },
      ],
      note: 'opcional',
    });
  }
  // …
}
```

**Sensores disponibles** en `src/core/sensors/`:

| Sensor | Fuente | Unidad |
|---|---|---|
| Acelerómetro | `accelerometerSource` | m/s² (gravedad incluida) |
| Giroscopio | `gyroscopeSource` | rad/s |
| Magnetómetro | `magnetometerSource` | µT |
| Barómetro | `barometerSource` | hPa |
| Luz (solo Android) | `lightSource` | lx |

Todas cumplen la interfaz `SensorSource`. En React, usa `useSensorSubscription`, que
cancela la suscripción al desmontar. Cámara y micrófono no pasan muestras al hilo JS: se
usan desde worklets con VisionCamera y react-native-audio-api.

**Adjuntos.** Pasa la URI temporal del fichero (caché, cámara, grabadora); el núcleo lo
copia a una carpeta permanente de la medición y lo borra cuando se borra la medición.

**Rendimiento.** Si tu sensor muestrea deprisa (más de ~30 Hz), no llames a `setState` en
cada muestra: acumula en un `useRef` o en un buffer circular y refresca la interfaz a
ritmo de pantalla. Para cámara y audio, procesa en worklets.

### 5. (Opcional) Calibración

Si tu instrumento necesita calibrarse (desfases, ganancias, matrices de color…), define:

```ts
calibration: {
  parametersSchemaVersion: 1,             // súbela si cambia la forma de los parámetros
  CalibrationScreen: MiCalibrationScreen, // recibe saveProfile(nombre, parámetros) y cancel()
  defaultParameters: { offsetDecibels: 0 },
  validateParameters: validarMisParametros, // lanza si no son válidos
},
```

El núcleo guarda los perfiles **por instrumento y por modelo de móvil**, deja activar uno u
otro y pasa los parámetros activos a tu pantalla. Si un perfil guardado ya no pasa
`validateParameters` o es de otra versión, se ignora y se usan los de por defecto.

### 6. Traducciones (`locales/es.json` y `locales/eu.json`)

Cada instrumento tiene su propio espacio de nombres i18n (su id). Los dos ficheros deben
tener **exactamente las mismas claves** y contener `nameKey`, `descriptionKey` y todos los
`labelKey` del esquema:

```json
{
  "name": "Sismógrafo",
  "description": "Vibraciones en tiempo real con el acelerómetro.",
  "fields": { "frequency": "Frecuencia dominante", "peak": "Pico" }
}
```

En la pantalla: `useTranslation('mi-instrumento')`. Para textos comunes del núcleo:
`t('core:common.save')`.

### 7. La definición (`index.ts`)

```ts
import { defineInstrument } from '@/core/instruments/types';

export const vibrationInstrument = defineInstrument<VibrationMeasurementValues>({
  id: 'mi-instrumento',
  nameKey: 'name',
  descriptionKey: 'description',
  icon: { glyph: '∿', accentColor: '#7A4FD1' },
  category: 'mechanics', // acoustics | mechanics | optics | electromagnetism | multi
  requiredSensors: ['accelerometer'],
  optionalSensors: ['gyroscope'],
  Screen: VibrationScreen,
  dataSchema: vibrationSchema,
  translations: { es, eu },
});
```

- `requiredSensors`: si alguno falta, el instrumento sale **deshabilitado con la
  explicación**. Si falta permiso, se ofrece un botón para pedirlo.
- `optionalSensors`: la pantalla puede consultarlos en `sensorAvailability` y activar
  funciones extra.
- Para combinaciones de sensores (sonido + vibración), pon ambos en `requiredSensors` y usa
  la categoría `multi`. Todas las muestras llevan `timestampSeconds` en el mismo reloj
  monotónico, así que se pueden alinear entre sí.

### 8. Regístralo (una línea)

```ts
// instruments/registry.ts
export const instrumentRegistry: readonly AnyInstrumentDefinition[] = [
  exampleLevelInstrument,
  vibrationInstrument, // ← aquí
];
```

El test `instruments/registry.test.ts` comprueba automáticamente que el id es válido y
único y que las traducciones están completas.

### 9. Pruébalo en un móvil real

1. `npm run android` (o `npm start` si ya tienes el dev build instalado y no has añadido
   dependencias nativas).
2. Comprueba que la tarjeta aparece y se abre, que guardar una medición funciona, que sale
   en **Historial** y que el CSV exportado tiene las columnas esperadas.
3. Si usas calibración: crea un perfil y comprueba que tu pantalla recibe los parámetros.
4. Revisa los dos idiomas en **Ajustes → Idioma**.

## Antes de abrir un pull request

```bash
npm test
npm run typecheck
npm run lint
```

Todo debe pasar. En la descripción del pull request, explica qué mide el instrumento,
cómo lo has probado (modelo de móvil) y, si aplica, cómo se ha validado la medida (contra
qué referencia).

Al contribuir, aceptas que tu código se publique bajo la licencia
[GPL-3.0-or-later](LICENSE) del proyecto.
