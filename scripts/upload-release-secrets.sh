#!/usr/bin/env bash
# Sube (o renueva) los secretos de firma que usa la Action de publicación.
# Lee las credenciales del fichero local, fuera del repositorio; nunca las muestra.
#   LAB_RELEASE_ENV_FILE (por defecto ~/.android-keys/laboratorio-de-bolsillo-release.env)
set -euo pipefail

releaseEnvironmentFile="${LAB_RELEASE_ENV_FILE:-$HOME/.android-keys/laboratorio-de-bolsillo-release.env}"
export GH_REPO="${GH_REPO:-JosuIru/laboratorio-de-bolsillo}"

if [[ ! -f "$releaseEnvironmentFile" ]]; then
  echo "ERROR: no encuentro las credenciales en $releaseEnvironmentFile" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$releaseEnvironmentFile"

for requiredVariable in LAB_RELEASE_STORE_FILE LAB_RELEASE_STORE_PASSWORD LAB_RELEASE_KEY_ALIAS LAB_RELEASE_KEY_PASSWORD; do
  if [[ -z "${!requiredVariable:-}" ]]; then
    echo "ERROR: falta $requiredVariable en $releaseEnvironmentFile" >&2
    exit 1
  fi
done

# Comprueba que la contraseña abre la clave antes de subir nada.
if ! keytool -list -keystore "$LAB_RELEASE_STORE_FILE" -storepass "$LAB_RELEASE_STORE_PASSWORD" >/dev/null 2>&1; then
  echo "ERROR: la contraseña no abre $LAB_RELEASE_STORE_FILE" >&2
  exit 1
fi

base64 -w0 "$LAB_RELEASE_STORE_FILE" | gh secret set LAB_RELEASE_KEYSTORE_BASE64
printf '%s' "$LAB_RELEASE_STORE_PASSWORD" | gh secret set LAB_RELEASE_STORE_PASSWORD
printf '%s' "$LAB_RELEASE_KEY_ALIAS" | gh secret set LAB_RELEASE_KEY_ALIAS
printf '%s' "$LAB_RELEASE_KEY_PASSWORD" | gh secret set LAB_RELEASE_KEY_PASSWORD

echo "Secretos actualizados en $GH_REPO:"
gh secret list
