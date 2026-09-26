#!/usr/bin/env bash
# Compila en local el APK de release firmado con la clave oficial.
# Las credenciales se leen de un fichero fuera del repositorio:
#   LAB_RELEASE_ENV_FILE (por defecto ~/.android-keys/laboratorio-de-bolsillo-release.env)
#
# Build incremental: `android/` solo se regenera desde cero (`prebuild --clean`) cuando cambian
# las dependencias o la configuración nativa (package-lock.json, plugins/, modules/). Si no,
# Gradle reaprovecha el C++ ya compilado. Para forzar el build limpio: LAB_CLEAN_BUILD=1.
#
# Opciones:
#   --arm64   solo arm64-v8a (móviles actuales; la mitad de tiempo). Para pruebas, no para publicar.
set -euo pipefail

projectRoot="$(cd "$(dirname "$0")/.." && pwd)"
releaseEnvironmentFile="${LAB_RELEASE_ENV_FILE:-$HOME/.android-keys/laboratorio-de-bolsillo-release.env}"

if [[ ! -f "$releaseEnvironmentFile" ]]; then
  echo "ERROR: no encuentro las credenciales de firma en $releaseEnvironmentFile" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$releaseEnvironmentFile"

cd "$projectRoot"
appVersion="$(node -p "require('./app.json').expo.version")"

nativeArchitectures="armeabi-v7a,arm64-v8a"
apkSuffix=""
for scriptArgument in "$@"; do
  case "$scriptArgument" in
    --arm64) nativeArchitectures="arm64-v8a"; apkSuffix="-arm64" ;;
    *) echo "ERROR: opción desconocida: $scriptArgument" >&2; exit 1 ;;
  esac
done

# Huella de lo que obliga a regenerar android/ desde cero (app.json no entra: la versión cambia en
# cada release y un prebuild sin --clean ya la aplica).
nativeFingerprint="$(
  {
    cat package-lock.json
    find plugins modules -type f -not -path '*/build/*' -not -path '*/.cxx/*' -not -path '*/node_modules/*' \
      -print0 | sort -z | xargs -0 sha256sum
  } | sha256sum | cut -d' ' -f1
)"
fingerprintFile="android/.lab-native-fingerprint"
if [[ "${LAB_CLEAN_BUILD:-0}" == "1" || ! -f "$fingerprintFile" || "$(cat "$fingerprintFile")" != "$nativeFingerprint" ]]; then
  echo "Dependencias nativas cambiadas (o build limpio pedido): prebuild --clean"
  npx expo prebuild --platform android --clean
  echo "$nativeFingerprint" > "$fingerprintFile"
else
  echo "Dependencias nativas iguales: prebuild incremental"
  npx expo prebuild --platform android
fi
(cd android && ./gradlew assembleRelease --build-cache -PreactNativeArchitectures="$nativeArchitectures")

mkdir -p dist
releaseApkPath="dist/laboratorio-de-bolsillo-$appVersion$apkSuffix.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$releaseApkPath"
bash scripts/verify-apk-signature.sh "$releaseApkPath"
echo "APK listo: $releaseApkPath"
