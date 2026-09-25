This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios|android` locally, or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md

## Laboratorio de Bolsillo: notas del proyecto

- Usa Node 24 (`.nvmrc`). El nvm del sistema puede estar en Node 18 por defecto: ejecuta `nvm use` o antepón `~/.nvm/versions/node/v24.*/bin` al PATH.
- Motor de worklets único: `react-native-worklets` (Software Mansion), fijado por el SDK de Expo. **No** instales `react-native-worklets-core`. Instala siempre `react-native-worklets`, `react-native-reanimated` y `@shopify/react-native-skia` con `npx expo install` para que queden alineados con el SDK.
- Las rutas van en `src/app/`, el núcleo en `src/core/`, el procesamiento puro (sin React ni RN) en `src/processing/` y los instrumentos en `instruments/<id>/`, registrados en `instruments/registry.ts`.
- Todos los textos visibles pasan por i18n (`es` y `eu`), y las dos lenguas deben tener las mismas claves (hay un test que lo comprueba).
- Usa nombres de variable descriptivos.
- Antes de añadir dependencias grandes que no estén ya en `package.json`, consúltalo.
- Firma y publicación: ver `RELEASING.md`. La clave de release vive en `~/.android-keys/` (nunca en el repo). El dev build usa el id `org.laboratoriodebolsillo.app.dev` (`npm run android` ya pasa `--app-id`).
- `app.json` declara `HIGH_SAMPLING_RATE_SENSORS`: sin él, en Android 12+ `expo-sensors` entrega unas 5 muestras/s.

## Trabajo en paralelo (varias sesiones)

Varias sesiones de Claude pueden trabajar a la vez en este repositorio, pero **nunca en la misma carpeta**:

1. **Un worktree y una rama por sesión.** La carpeta principal (`~/Projects/app-kamara`, rama `main`) es de la sesión que integra. Las demás trabajan en su propio worktree: `EnterWorktree`, `claude --worktree`, o `git worktree add ../app-kamara-<tema> -b feat/<tema>`. Dentro, ejecuta `npm ci` antes de nada.
2. **Nunca `git add -A` a ciegas:** revisa `git status` y añade solo tus ficheros.
3. **Metro en un puerto propio:** la sesión de `main` usa el 8081; las demás, 8082, 8083… (`npx expo start --dev-client --port 8082`, y `adb reverse tcp:8082 tcp:8082`).
4. **Zonas compartidas:** `package.json`, `package-lock.json`, `app.json`, `plugins/` y `src/core/` solo los toca la sesión de `main`. Si otra sesión los necesita, lo pide antes por `SendMessage`. Cada instrumento nuevo vive en su carpeta `instruments/<id>/` y solo añade una línea a `instruments/registry.ts`.
5. **Recursos físicos únicos:** un solo build de Gradle a la vez (tarda 10-15 min y satura la CPU) y una sola sesión instalando en el móvil. Avisa por `SendMessage` antes de compilar o instalar.
6. **Integración por PR** desde la rama de cada sesión hacia `main`, de uno en uno.
