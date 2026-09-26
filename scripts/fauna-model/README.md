# Modelo de fauna por sonido (instrumento «¿Quién canta?»)

Scripts para rehacer el modelo que usa `instruments/wildlife-sounds`: **Perch 2.0** de Google
recortado a las especies con registros en Europa más los sonidos generales, y pasado a float16.
El modelo **no va en el APK**: la app lo descarga la primera vez desde la release de GitHub
[`modelo-fauna-europa-1`](https://github.com/JosuIru/laboratorio-de-bolsillo/releases/tag/modelo-fauna-europa-1),
que tiene dos ficheros: `perch_europe_fp16.tflite` y `fauna-manifest.json`.

## Licencias

- Perch 2.0 (pesos y etiquetas): Apache 2.0, © Google. El modelo recortado es una obra derivada
  y se distribuye con la misma licencia.
- Nombres comunes: [GBIF](https://www.gbif.org/) (Catalogue of Life, ITIS, IOC… cada uno con su
  licencia abierta; ver la API `species/{key}/vernacularNames`).
- Etiquetas de sonidos generales: ontología de AudioSet / FSD50K (CC BY). Las traducciones de
  `general-sound-names.json` son de este proyecto.

## Pasos

Todo se ejecuta dentro de una carpeta de trabajo (no en el repo: los modelos pesan cientos de MB).

```bash
mkdir -p ~/fauna && cd ~/fauna
cp <repo>/scripts/fauna-model/* .
python3 -m venv venv && . venv/bin/activate
pip install ai-edge-litert flatbuffers numpy

# 1. Modelo completo (≈400 MB, 14 795 clases) y sus etiquetas
curl -LO https://huggingface.co/justinchuby/Perch-onnx/resolve/main/perch_v2.tflite
curl -L -o labels.csv https://huggingface.co/cgeorgiaw/Perch/resolve/main/assets/labels.csv

# 2. Especies de aves, anfibios, mamíferos, insectos y reptiles con ≥ 200 registros en Europa
#    según GBIF que están entre las clases de Perch → europe_species.json
python europe_species.py

# 3. Nombres comunes (es, eu, en) desde GBIF → species_names.json
#    (en el repo se guarda la versión usada en europa-1: GBIF cambia con el tiempo)
python vernacular_names.py

# 4. Recorta la cabeza del modelo a esas especies + los sonidos generales de FSD50K
python slice_model.py perch_v2.tflite perch_europe.tflite perch_europe_labels.txt

# 5. Pesos a float16 (74 MB → 37 MB; un DEQUANTIZE los devuelve a float32 al cargar)
python to_float16.py perch_europe.tflite perch_europe_fp16.tflite

# 6. Comprobación con grabaciones reales en audio/<Género_especie>.f32 (mono, 32 kHz, float32)
MODELO_PRUEBA=perch_europe_fp16.tflite python validate.py

# 7. Manifiesto para la app
python build_manifest.py perch_europe_fp16.tflite fauna-manifest.json
```

Después, sube `perch_europe_fp16.tflite` y `fauna-manifest.json` como assets de la release
`modelo-fauna-europa-1`. Si cambia el modelo, usa otro tag y otra `modelVersion`
(`europa-2`…) y actualiza la URL en `instruments/wildlife-sounds/modelStore.ts`.

## El modelo

- Entrada: float32 `[1, 160000]`: 5 s de audio mono a 32 kHz, amplitud −1…1.
- Salidas, en este orden:
  0. `embedding` `[1, 1536]`
  1. `spatial_embedding` `[1, 16, 4, 1536]`
  2. `spectrogram` `[1, 500, 128]` (log-mel)
  3. `logits` `[1, 1226]`: puntuaciones, no probabilidades (≈6–15 en los aciertos).
- 1226 clases: 1028 especies europeas + 198 sonidos generales (Bark, Speech, Car…).

`fauna-manifest.json` lleva el tamaño y el SHA-256 del modelo (la app los comprueba tras la
descarga), el orden de las salidas y, en el orden de los logits, cada clase con su tipo
(`species` o `sound`), su grupo (`bird`, `amphibian`, `mammal`, `insect`) y sus nombres. Las
etiquetas de voz humana (lista en `build_manifest.py`) llevan `isHumanVoice: true`: la app no
guarda las detecciones en las que aparecen.

## Validación (europa-1)

Con LiteRT en el portátil, sobre 7 grabaciones reales (mirlo, petirrojo, pinzón, ruiseñor,
carbonero, sapo común y grillo campestre), la clase correcta sale **la primera en 6 de 7**.
`validate.py` también muestra la diferencia máxima de logits frente al modelo completo en las
mismas clases. Es un resultado orientativo: pocas grabaciones y todas bastante limpias.
