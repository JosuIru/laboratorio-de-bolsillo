#!/usr/bin/env bash
# Compila en local el APK de release firmado con la clave oficial.
# Las credenciales se leen de un fichero fuera del repositorio:
#   LAB_RELEASE_ENV_FILE (por defecto ~/.android-keys/laboratorio-de-bolsillo-release.env)
#
# Build incremental: `android/` solo se regenera desde cero (`prebuild --clean`) cuando cambian
# las dependencias o la configuración nativa (package-lock.json, plugins/, modules/). Si no,
# Gradle reaprovecha el C++ ya compilado. Para forzar el build limpio: LAB_CLEAN_BUILD=1.
#
# Genera un APK por arquitectura además del universal (plugin withAndroidAbiSplits) y los deja en dist/:
#   laboratorio-de-bolsillo-<v>.apk              universal: vale para cualquier móvil
#   laboratorio-de-bolsillo-<v>-arm64-v8a.apk    64 bits (casi todos los móviles actuales), más pequeño
#   laboratorio-de-bolsillo-<v>-armeabi-v7a.apk  32 bits
#
# Opciones:
#   --arm64   solo arm64-v8a (la mitad de tiempo): deja únicamente el APK de 64 bits. Para pruebas.
set -euo pipefail

projectRoot="$(cd "$(dirname "$0")/.." && pwd)"
releaseEnvironmentFile="${LAB_RELEASE_ENV_FILE:-$HOME/.android-keys/laboratorio-de-bolsillo-release.env}"

if [[ ! -f "$releaseEnvironmentFile" ]]; then
  echo "ERROR: no encuentro las credenciales de firma en $releaseEnvironmentFile" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$releaseEnvironmentFile"

# `prebuild --clean` borra android/local.properties, así que Gradle solo encuentra el SDK por
# ANDROID_HOME. Si no está en el entorno, se usa la ruta por defecto de Android Studio.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"

cd "$projectRoot"
appVersion="$(node -p "require('./app.json').expo.version")"

nativeArchitectures="armeabi-v7a,arm64-v8a"
isArm64Only=0
for scriptArgument in "$@"; do
  case "$scriptArgument" in
    --arm64) nativeArchitectures="arm64-v8a"; isArm64Only=1 ;;
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
apkOutputDirectory="android/app/build/outputs/apk/release"
# Sin APK de builds anteriores: así no se copia uno viejo de otra arquitectura.
rm -f "$apkOutputDirectory"/*.apk
(cd android && ./gradlew assembleRelease --build-cache -PreactNativeArchitectures="$nativeArchitectures")

mkdir -p dist
distributionApkPrefix="dist/laboratorio-de-bolsillo-$appVersion"
if [[ "$isArm64Only" == "0" ]]; then
  # Se van a publicar con `dist/laboratorio-de-bolsillo-<v>*.apk`: fuera los de builds anteriores.
  rm -f "$distributionApkPrefix".apk "$distributionApkPrefix"-*.apk
fi

copiedApkPaths=()
# Copia un APK de Gradle a dist/ y verifica que está firmado con la clave oficial.
copyAndVerifyApk() {
  local gradleApkPath="$1" distributionApkPath="$2"
  cp "$gradleApkPath" "$distributionApkPath"
  bash scripts/verify-apk-signature.sh "$distributionApkPath"
  copiedApkPaths+=("$distributionApkPath")
}

if [[ -f "$apkOutputDirectory/app-universal-release.apk" ]]; then
  copyAndVerifyApk "$apkOutputDirectory/app-universal-release.apk" "$distributionApkPrefix.apk"
elif [[ -f "$apkOutputDirectory/app-release.apk" ]]; then
  # Sin divisiones por ABI (plugin desactivado): un solo APK con lo que se haya compilado.
  if [[ "$isArm64Only" == "1" ]]; then
    copyAndVerifyApk "$apkOutputDirectory/app-release.apk" "$distributionApkPrefix-arm64-v8a.apk"
  else
    copyAndVerifyApk "$apkOutputDirectory/app-release.apk" "$distributionApkPrefix.apk"
  fi
elif [[ "$isArm64Only" == "0" ]]; then
  echo "ERROR: Gradle no ha generado el APK universal en $apkOutputDirectory" >&2
  exit 1
fi
for apkArchitecture in arm64-v8a armeabi-v7a; do
  if [[ -f "$apkOutputDirectory/app-$apkArchitecture-release.apk" ]]; then
    copyAndVerifyApk "$apkOutputDirectory/app-$apkArchitecture-release.apk" "$distributionApkPrefix-$apkArchitecture.apk"
  fi
done

if [[ ${#copiedApkPaths[@]} -eq 0 ]]; then
  echo "ERROR: no hay ningún APK en $apkOutputDirectory" >&2
  exit 1
fi
echo "APK listos:"
printf '  %s\n' "${copiedApkPaths[@]}"
