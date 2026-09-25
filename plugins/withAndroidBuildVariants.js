/**
 * Config plugin de Expo para Android:
 *
 * 1. Firma de release: si existen las variables LAB_RELEASE_STORE_FILE, LAB_RELEASE_STORE_PASSWORD,
 *    LAB_RELEASE_KEY_ALIAS y LAB_RELEASE_KEY_PASSWORD (como variables de entorno o propiedades
 *    de Gradle), el APK de release se firma con esa clave. Si no, se firma con la de depuración
 *    y Gradle avisa: sirve para compilar en local, pero ese APK no debe publicarse.
 * 2. El build de depuración usa el id `<paquete>.dev` y otro nombre, para poder tener instalados
 *    a la vez el dev build y la versión publicada.
 *
 * Las claves y contraseñas nunca están en el repositorio.
 */
const fs = require('fs');
const path = require('path');
const { withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');

const signingMarker = '// laboratorio-de-bolsillo: release signing';

const releaseSigningConfig = `
        ${signingMarker}
        release {
            def releaseSigningValue = { String propertyName ->
                def propertyValue = findProperty(propertyName) ?: System.getenv(propertyName)
                return propertyValue ? propertyValue.toString() : null
            }
            def releaseStoreFilePath = releaseSigningValue('LAB_RELEASE_STORE_FILE')
            if (releaseStoreFilePath) {
                storeFile file(releaseStoreFilePath)
                storePassword releaseSigningValue('LAB_RELEASE_STORE_PASSWORD')
                keyAlias releaseSigningValue('LAB_RELEASE_KEY_ALIAS')
                keyPassword releaseSigningValue('LAB_RELEASE_KEY_PASSWORD')
            }
        }`;

function withReleaseSigning(config) {
  return withAppBuildGradle(config, (gradleConfig) => {
    let buildGradle = gradleConfig.modResults.contents;
    if (buildGradle.includes(signingMarker)) return gradleConfig;

    const debugSigningPattern = /(signingConfigs\s*\{\s*debug\s*\{[^}]*\})/;
    const releaseSigningPattern =
      /(release\s*\{\s*(?:\/\/[^\n]*\n\s*)*)signingConfig signingConfigs\.debug/;
    const debugBuildTypePattern = /(buildTypes\s*\{\s*debug\s*\{\s*signingConfig signingConfigs\.debug)/;

    if (!debugSigningPattern.test(buildGradle) || !releaseSigningPattern.test(buildGradle)) {
      throw new Error('withAndroidBuildVariants: el build.gradle generado ha cambiado; revisa el plugin.');
    }

    buildGradle = buildGradle.replace(debugSigningPattern, `$1${releaseSigningConfig}`);
    buildGradle = buildGradle.replace(
      releaseSigningPattern,
      `$1if (signingConfigs.release.storeFile != null) {
                signingConfig signingConfigs.release
            } else {
                if (gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }) {
                    logger.warn('AVISO: APK de release firmado con la clave de DEPURACIÓN. No lo publiques.')
                }
                signingConfig signingConfigs.debug
            }`,
    );
    buildGradle = buildGradle.replace(debugBuildTypePattern, `$1\n            applicationIdSuffix '.dev'`);

    gradleConfig.modResults.contents = buildGradle;
    return gradleConfig;
  });
}

function withDebugAppName(config, { debugAppName }) {
  return withDangerousMod(config, [
    'android',
    async (dangerousConfig) => {
      const debugValuesDirectory = path.join(
        dangerousConfig.modRequest.platformProjectRoot,
        'app/src/debug/res/values',
      );
      fs.mkdirSync(debugValuesDirectory, { recursive: true });
      const escapedAppName = debugAppName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, "\\'");
      fs.writeFileSync(
        path.join(debugValuesDirectory, 'strings.xml'),
        `<resources>\n  <string name="app_name">${escapedAppName}</string>\n</resources>\n`,
      );
      return dangerousConfig;
    },
  ]);
}

module.exports = function withAndroidBuildVariants(config, options = {}) {
  const debugAppName = options.debugAppName ?? `${config.name} (dev)`;
  return withDebugAppName(withReleaseSigning(config), { debugAppName });
};
