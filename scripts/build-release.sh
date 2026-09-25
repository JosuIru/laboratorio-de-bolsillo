#!/usr/bin/env bash
# Compila en local el APK de release firmado con la clave oficial.
# Las credenciales se leen de un fichero fuera del repositorio:
#   LAB_RELEASE_ENV_FILE (por defecto ~/.android-keys/laboratorio-de-bolsillo-release.env)
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

npx expo prebuild --platform android --clean
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=armeabi-v7a,arm64-v8a)

mkdir -p dist
releaseApkPath="dist/laboratorio-de-bolsillo-$appVersion.apk"
cp android/app/build/outputs/apk/release/app-release.apk "$releaseApkPath"
bash scripts/verify-apk-signature.sh "$releaseApkPath"
echo "APK listo: $releaseApkPath"
