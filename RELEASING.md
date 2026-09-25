# Publicar una versión

La app busca actualizaciones en las
[Releases de GitHub](https://github.com/JosuIru/laboratorio-de-bolsillo/releases) cuando el
usuario pulsa **Ajustes → Actualizaciones → Buscar actualizaciones**. Para que detecte una
versión nueva, la release tiene que cumplir tres condiciones:

1. El **tag** es una versión semántica mayor que la instalada: `v0.2.0`, `v1.0.0`…
2. **No** es borrador ni *prerelease* (esos se ignoran; sirven para pruebas).
3. Lleva adjunto un fichero **`.apk`**, que es el que ofrece descargar.

## Pasos

1. Sube la versión en `app.json`:
   - `expo.version`: `0.2.0` (la que ve el usuario y la que se compara con el tag)
   - `expo.android.versionCode`: súmale 1 (Android no instala una actualización con un
     `versionCode` igual o menor)
2. Haz commit y crea el tag:
   ```bash
   git commit -am "Versión 0.2.0"
   git tag v0.2.0
   git push && git push --tags
   ```
3. Compila el APK de release **firmado siempre con la misma clave** (ver abajo):
   ```bash
   npm run prebuild
   cd android && ./gradlew assembleRelease
   ```
4. Publica la release con el APK y las notas:
   ```bash
   gh release create v0.2.0 \
     android/app/build/outputs/apk/release/app-release.apk#laboratorio-de-bolsillo-0.2.0.apk \
     --title "0.2.0" --notes-file NOTAS.md
   ```

## La firma: importante

Android solo instala una actualización encima de la versión anterior si **las dos están
firmadas con la misma clave**. Si cambia la clave, el usuario tiene que desinstalar la app
y **pierde sus mediciones**.

- Todavía **no hay clave de release configurada**: `assembleRelease` usa la clave de
  depuración de la máquina que compila. Antes de publicar la primera versión hay que crear
  una clave de release, guardarla fuera del repositorio (nunca en git) y configurar la
  firma.
- Los *dev builds* que se instalan con `npm run android` usan la clave de depuración, así
  que un APK de release no se puede instalar encima de un dev build sin desinstalarlo antes.
