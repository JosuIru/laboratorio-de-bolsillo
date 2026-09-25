#!/usr/bin/env bash
# Comprueba que un APK está firmado con el certificado oficial del proyecto
# (huella SHA-256 pública en android-signing-certificate.sha256).
# Uso: scripts/verify-apk-signature.sh ruta/al.apk
set -euo pipefail

apkPath="${1:?Uso: $0 ruta/al.apk}"
projectRoot="$(cd "$(dirname "$0")/.." && pwd)"
expectedCertificateDigest="$(tr -d '[:space:]' < "$projectRoot/android-signing-certificate.sha256")"

androidSdkRoot="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
latestBuildToolsVersion="$(ls "$androidSdkRoot/build-tools" | sort -V | tail -1)"
apksignerPath="$androidSdkRoot/build-tools/$latestBuildToolsVersion/apksigner"

actualCertificateDigest="$("$apksignerPath" verify --print-certs "$apkPath" \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | tr -d '[:space:]')"

if [[ "$actualCertificateDigest" != "$expectedCertificateDigest" ]]; then
  echo "ERROR: $apkPath no está firmado con la clave oficial." >&2
  echo "  esperado: $expectedCertificateDigest" >&2
  echo "  obtenido: ${actualCertificateDigest:-(sin firma válida)}" >&2
  exit 1
fi
echo "Firma correcta: $apkPath"
