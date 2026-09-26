# Publicar una versión

La app busca actualizaciones en las
[Releases de GitHub](https://github.com/JosuIru/laboratorio-de-bolsillo/releases) cuando el
usuario pulsa **Ajustes → Actualizaciones → Buscar actualizaciones**. Una release se detecta
si su tag es una versión semántica mayor que la instalada (`v0.2.0`), no es borrador ni
*prerelease* y lleva adjunto un `.apk`.

## Publicar (automático)

1. Sube la versión en `app.json`:
   - `expo.version`: `0.4.6` (la que ve el usuario y la que se compara con el tag)
   - `expo.android.versionCode`: súmale 1 (Android no instala una actualización con un
     `versionCode` igual o menor)
2. Haz commit, crea el tag y súbelo:
   ```bash
   git commit -am "Versión 0.2.0"
   git tag v0.2.0
   git push && git push --tags
   ```
3. La Action [`release.yml`](.github/workflows/release.yml) hace el resto:
   - comprueba que el tag coincide con `app.json`
   - pasa tests, tipos y lint
   - compila los APK de release (universal y por arquitectura, ver abajo) y verifica que
     todos están firmados con la clave oficial
   - crea la release con los APK y notas generadas a partir de los commits

   Tarda unos 15-20 minutos. Puedes seguirla en la pestaña *Actions* del repositorio.

## Qué APK se publican

El plugin [`withAndroidAbiSplits`](plugins/withAndroidAbiSplits.js) activa las divisiones por
arquitectura (*ABI splits*) en los builds de release: un solo `assembleRelease` genera un APK
por arquitectura y otro universal. Todos llevan el mismo `versionCode` y la misma firma.

| Fichero en la release | Para qué móviles | Tamaño |
|---|---|---|
| `laboratorio-de-bolsillo-<v>.apk` | cualquiera (universal: lleva las dos arquitecturas) | el mayor |
| `laboratorio-de-bolsillo-<v>-arm64-v8a.apk` | 64 bits: casi todos los actuales | ~la mitad |
| `laboratorio-de-bolsillo-<v>-armeabi-v7a.apk` | 32 bits: móviles antiguos | ~la mitad |

La app (**Ajustes → Actualizaciones**) elige el APK de la arquitectura del móvil y, si no lo
encuentra, el universal. Lo descarga dentro de la propia app (en su caché, no en Descargas),
muestra el progreso, no lo vuelve a bajar si ya lo tiene completo y abre el instalador de
Android. El APK se borra solo al arrancar la versión nueva.

Las versiones de la app hasta la 0.4.5 cogen **el primer `.apk`** de la release y lo abren con
el navegador. Por eso el universal se sube primero y solo, y los demás después.

x86 solo lo usan los emuladores: no se compila para publicar.

## Compilar en local

```bash
npm run build:release   # deja los tres APK firmados en dist/
```

El script copia a `dist/` el universal como `laboratorio-de-bolsillo-<versión>.apk` y los de
cada arquitectura como `laboratorio-de-bolsillo-<versión>-arm64-v8a.apk` y
`laboratorio-de-bolsillo-<versión>-armeabi-v7a.apk`, y comprueba la firma de cada uno con
`scripts/verify-apk-signature.sh`. Antes borra de `dist/` los APK anteriores de esa versión.

Para probar en un móvil actual basta con `npm run build:release:arm64`: compila solo
`arm64-v8a`, tarda la mitad y deja únicamente
`dist/laboratorio-de-bolsillo-<versión>-arm64-v8a.apk`. No publiques una release solo con él:
los móviles de 32 bits se quedarían sin APK.

### Publicar a mano (sin la Action)

Con los tres APK en `dist/`, primero el universal y luego los demás:

```bash
gh release create v<X> dist/laboratorio-de-bolsillo-<X>.apk --title "<X>" --generate-notes
gh release upload v<X> dist/laboratorio-de-bolsillo-<X>-*.apk
```

También vale de una vez, `gh release create v<X> dist/laboratorio-de-bolsillo-<X>*.apk`, pero
entonces el orden de los ficheros no está garantizado y una app 0.4.5 o anterior podría abrir
el APK de 64 bits en un móvil de 32.

El build es incremental: `android/` solo se regenera desde cero cuando cambian
`package-lock.json`, `plugins/` o `modules/`. Si no cambian, se reaprovecha el C++ ya compilado.
Para forzar un build limpio: `LAB_CLEAN_BUILD=1 npm run build:release`.

Lee las credenciales de `~/.android-keys/laboratorio-de-bolsillo-release.env` (o de la ruta
que indiques en `LAB_RELEASE_ENV_FILE`). Si no hay credenciales, Gradle firma con la clave
de depuración y avisa: ese APK **no se debe publicar**.

## La clave de firma

Android solo instala una actualización encima de la versión anterior si **las dos están
firmadas con la misma clave**. Si se pierde la clave, no se pueden publicar más
actualizaciones: los usuarios tendrían que desinstalar la app y **perderían sus mediciones**.

- **Clave:** `~/.android-keys/laboratorio-de-bolsillo-release.p12` (PKCS12, RSA 4096,
  alias `laboratorio-de-bolsillo`, válida 10 000 días).
- **Credenciales:** `~/.android-keys/laboratorio-de-bolsillo-release.env`.
- **Huella pública del certificado** (SHA-256):
  [`android-signing-certificate.sha256`](android-signing-certificate.sha256). La comprueban
  `scripts/verify-apk-signature.sh` y la Action antes de publicar. Cualquiera puede usarla
  para verificar que un APK es oficial:
  ```bash
  bash scripts/verify-apk-signature.sh laboratorio-de-bolsillo-0.2.0.apk
  ```
- **Nunca** subas la clave ni el `.env` al repositorio.
- **Haz copia de seguridad** de los dos ficheros en un sitio seguro fuera de este ordenador
  (gestor de contraseñas, disco cifrado…).

### Secretos de GitHub que usa la Action

| Secreto | Contenido |
|---|---|
| `LAB_RELEASE_KEYSTORE_BASE64` | el `.p12` en base64 |
| `LAB_RELEASE_STORE_PASSWORD` | contraseña del almacén |
| `LAB_RELEASE_KEY_ALIAS` | `laboratorio-de-bolsillo` |
| `LAB_RELEASE_KEY_PASSWORD` | contraseña de la clave (en PKCS12, la misma) |

Para darlos de alta (o renovarlos) desde este ordenador:

```bash
bash scripts/upload-release-secrets.sh
```

El script comprueba que la contraseña abre la clave antes de subir nada y nunca muestra las
credenciales.

## Dev build y versión publicada a la vez

El dev build (`npm run android`) se instala como **«Laboratorio (dev)»** con el id
`org.laboratoriodebolsillo.app.dev`, y la versión publicada como «Laboratorio de Bolsillo»
con `org.laboratoriodebolsillo.app`. Pueden convivir en el mismo móvil, pero **cada una
tiene sus propios datos**.
