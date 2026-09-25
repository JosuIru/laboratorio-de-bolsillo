# Publicar una versión

La app busca actualizaciones en las
[Releases de GitHub](https://github.com/JosuIru/laboratorio-de-bolsillo/releases) cuando el
usuario pulsa **Ajustes → Actualizaciones → Buscar actualizaciones**. Una release se detecta
si su tag es una versión semántica mayor que la instalada (`v0.2.0`), no es borrador ni
*prerelease* y lleva adjunto un `.apk`.

## Publicar (automático)

1. Sube la versión en `app.json`:
   - `expo.version`: `0.2.0` (la que ve el usuario y la que se compara con el tag)
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
   - compila el APK de release y verifica que está firmado con la clave oficial
   - crea la release con el APK y notas generadas a partir de los commits

   Tarda unos 15-20 minutos. Puedes seguirla en la pestaña *Actions* del repositorio.

## Compilar en local

```bash
npm run build:release   # deja el APK firmado en dist/
```

El APK incluye solo las arquitecturas ARM (`arm64-v8a` y `armeabi-v7a`), que cubren
prácticamente todos los móviles; x86 solo lo usan los emuladores.

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
