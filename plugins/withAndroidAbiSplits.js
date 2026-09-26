/**
 * Config plugin de Expo para Android: APK por arquitectura (ABI splits).
 *
 * En los builds de release, un solo `assembleRelease` genera en
 * `android/app/build/outputs/apk/release/`:
 *   - `app-arm64-v8a-release.apk`   (móviles de 64 bits, casi todos los actuales)
 *   - `app-armeabi-v7a-release.apk` (móviles de 32 bits)
 *   - `app-universal-release.apk`   (las arquitecturas compiladas, el que sirve siempre; sin x86)
 *
 * Las arquitecturas salen de `-PreactNativeArchitectures` (las mismas para las que se compila el
 * C++), así que `--arm64` genera solo `app-arm64-v8a-release.apk`: si se compila una sola
 * arquitectura no hace falta el universal. Todos llevan el mismo `versionCode` (vale para GitHub;
 * Google Play pediría uno distinto por ABI).
 *
 * Los builds de depuración no se tocan: `expo run:android` sigue generando un solo APK.
 */
const { withAppBuildGradle } = require('expo/config-plugins');

const abiSplitsMarker = '// laboratorio-de-bolsillo: ABI splits';

const abiSplitsConfig = `
    ${abiSplitsMarker}
    def labArchitecturesProperty = findProperty('reactNativeArchitectures') ?: 'armeabi-v7a,arm64-v8a'
    def labBuildArchitectures = labArchitecturesProperty.toString().split(',').collect { it.trim() }.findAll { it }
    def labIsReleaseBuild = gradle.startParameter.taskNames.any { it.toLowerCase().contains('release') }
    splits {
        abi {
            enable labIsReleaseBuild && !labBuildArchitectures.isEmpty()
            reset()
            include(*labBuildArchitectures)
            universalApk labBuildArchitectures.size() > 1
        }
    }
    // Con los splits activos, el APK universal mete también las librerías x86/x86_64 que traen
    // ya compiladas algunas dependencias (LiteRT, Skia…): ~50 MB que ningún móvil usa. Fuera.
    packaging {
        jniLibs {
            if (labIsReleaseBuild) {
                ['x86', 'x86_64', 'armeabi-v7a', 'arm64-v8a'].findAll { !labBuildArchitectures.contains(it) }.each { unusedArchitecture ->
                    excludes += ["lib/\${unusedArchitecture}/**".toString()]
                }
            }
        }
    }
`;

function withAndroidAbiSplits(config) {
  return withAppBuildGradle(config, (gradleConfig) => {
    const buildGradle = gradleConfig.modResults.contents;
    if (buildGradle.includes(abiSplitsMarker)) return gradleConfig;

    const androidBlockPattern = /^android\s*\{\n/m;
    if (!androidBlockPattern.test(buildGradle)) {
      throw new Error('withAndroidAbiSplits: el build.gradle generado ha cambiado; revisa el plugin.');
    }
    gradleConfig.modResults.contents = buildGradle.replace(androidBlockPattern, (androidBlockStart) =>
      `${androidBlockStart}${abiSplitsConfig}`,
    );
    return gradleConfig;
  });
}

module.exports = withAndroidAbiSplits;
