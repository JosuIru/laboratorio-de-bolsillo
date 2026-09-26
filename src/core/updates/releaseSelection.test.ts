import {
  compareSemanticVersions,
  detectApkAbi,
  evaluateLatestRelease,
  type GitHubReleaseResponse,
  isTrustedGitHubUrl,
  parseSemanticVersion,
  pickApkAsset,
} from './releaseSelection';

describe('parseSemanticVersion', () => {
  it.each([
    ['0.1.0', { major: 0, minor: 1, patch: 0 }],
    ['v1.12.3', { major: 1, minor: 12, patch: 3 }],
    [' v2.0.0-beta.1 ', { major: 2, minor: 0, patch: 0 }],
  ])('%j', (versionText, expectedVersion) => {
    expect(parseSemanticVersion(versionText)).toEqual(expectedVersion);
  });

  it.each(['', 'latest', '1.2', 'v1.2.x'])('rechaza %j', (invalidVersionText) => {
    expect(parseSemanticVersion(invalidVersionText)).toBeNull();
  });
});

describe('compareSemanticVersions', () => {
  const version = (versionText: string) => parseSemanticVersion(versionText)!;
  it('compara numéricamente, no como texto', () => {
    expect(compareSemanticVersions(version('0.10.0'), version('0.9.9'))).toBeGreaterThan(0);
    expect(compareSemanticVersions(version('1.0.0'), version('1.0.1'))).toBeLessThan(0);
    expect(compareSemanticVersions(version('v2.3.4'), version('2.3.4'))).toBe(0);
  });
});

describe('isTrustedGitHubUrl', () => {
  it.each([
    ['https://github.com/JosuIru/laboratorio-de-bolsillo/releases/tag/v0.2.0', true],
    ['https://objects.githubusercontent.com/x/app.apk', true],
    ['http://github.com/inseguro', false],
    ['https://github.com.malicioso.example/app.apk', false],
    ['https://malicioso.example/github.com/app.apk', false],
    ['javascript:alert(1)', false],
  ])('%s → %s', (candidateUrl, isExpectedTrusted) => {
    expect(isTrustedGitHubUrl(candidateUrl)).toBe(isExpectedTrusted);
  });
});

describe('evaluateLatestRelease', () => {
  const publishedRelease: GitHubReleaseResponse = {
    tag_name: 'v0.2.0',
    name: 'Sismógrafo',
    body: '  Novedades de la versión  ',
    html_url: 'https://github.com/JosuIru/laboratorio-de-bolsillo/releases/tag/v0.2.0',
    draft: false,
    prerelease: false,
    published_at: '2026-10-01T10:00:00Z',
    assets: [
      { name: 'checksums.txt', browser_download_url: 'https://github.com/x/checksums.txt', size: 100 },
      { name: 'laboratorio-0.2.0.apk', browser_download_url: 'https://github.com/x/laboratorio-0.2.0.apk', size: 42_000_000 },
    ],
  };

  it('detecta una versión más nueva y elige el APK', () => {
    expect(evaluateLatestRelease('0.1.0', publishedRelease)).toEqual({
      status: 'update-available',
      currentVersion: '0.1.0',
      release: {
        version: '0.2.0',
        releaseName: 'Sismógrafo',
        releaseNotes: 'Novedades de la versión',
        releasePageUrl: 'https://github.com/JosuIru/laboratorio-de-bolsillo/releases/tag/v0.2.0',
        publishedAt: '2026-10-01T10:00:00Z',
        apkDownloadUrl: 'https://github.com/x/laboratorio-0.2.0.apk',
        apkSizeBytes: 42_000_000,
        apkAbi: null,
      },
    });
  });

  it('está al día si la release es igual o anterior', () => {
    expect(evaluateLatestRelease('0.2.0', publishedRelease).status).toBe('up-to-date');
    expect(evaluateLatestRelease('0.3.1', publishedRelease).status).toBe('up-to-date');
  });

  it('ignora borradores, prereleases, tags raros o la ausencia de releases', () => {
    expect(evaluateLatestRelease('0.1.0', null).status).toBe('no-releases');
    expect(evaluateLatestRelease('0.1.0', { ...publishedRelease, draft: true }).status).toBe('no-releases');
    expect(evaluateLatestRelease('0.1.0', { ...publishedRelease, prerelease: true }).status).toBe('no-releases');
    expect(evaluateLatestRelease('0.1.0', { ...publishedRelease, tag_name: 'nightly' }).status).toBe('no-releases');
  });

  it('descarta enlaces que no son de GitHub', () => {
    const tamperedRelease = {
      ...publishedRelease,
      html_url: 'https://malicioso.example/release',
      assets: [{ name: 'app.apk', browser_download_url: 'https://malicioso.example/app.apk', size: 1 }],
    };
    const updateCheckResult = evaluateLatestRelease('0.1.0', tamperedRelease);
    expect(updateCheckResult.status === 'update-available' && updateCheckResult.release).toMatchObject({
      releasePageUrl: '',
      apkDownloadUrl: null,
    });
  });
});

describe('detectApkAbi', () => {
  it.each([
    ['laboratorio-de-bolsillo-0.5.0.apk', null],
    ['laboratorio-de-bolsillo-0.5.0-universal.apk', null],
    ['laboratorio-de-bolsillo-0.5.0-arm64-v8a.apk', 'arm64-v8a'],
    ['laboratorio-de-bolsillo-0.5.0-armeabi-v7a.apk', 'armeabi-v7a'],
    ['laboratorio-de-bolsillo-0.5.0-x86_64.apk', 'x86_64'],
    ['laboratorio-de-bolsillo-0.4.4-arm64.apk', 'arm64-v8a'],
  ])('%s → %s', (apkFileName, expectedAbi) => {
    expect(detectApkAbi(apkFileName)).toBe(expectedAbi);
  });
});

describe('pickApkAsset', () => {
  const releaseAsset = (fileName: string, sizeBytes: number) => ({
    name: fileName,
    browser_download_url: `https://github.com/JosuIru/laboratorio-de-bolsillo/releases/download/v0.5.0/${fileName}`,
    size: sizeBytes,
  });
  const universalApk = releaseAsset('laboratorio-de-bolsillo-0.5.0.apk', 116_000_000);
  const arm64Apk = releaseAsset('laboratorio-de-bolsillo-0.5.0-arm64-v8a.apk', 62_000_000);
  const armeabiApk = releaseAsset('laboratorio-de-bolsillo-0.5.0-armeabi-v7a.apk', 55_000_000);
  const modernPhoneAbis = ['arm64-v8a', 'armeabi-v7a', 'armeabi'];
  const oldPhoneAbis = ['armeabi-v7a', 'armeabi'];

  it('solo universal: lo elige en cualquier móvil', () => {
    expect(pickApkAsset([universalApk], modernPhoneAbis)).toMatchObject({ fileName: universalApk.name, abi: null });
    expect(pickApkAsset([universalApk], null)).toMatchObject({ fileName: universalApk.name });
  });

  it('universal + arm64: el de 64 bits en un móvil de 64 bits, con su tamaño', () => {
    expect(pickApkAsset([universalApk, arm64Apk], modernPhoneAbis)).toEqual({
      fileName: arm64Apk.name,
      downloadUrl: arm64Apk.browser_download_url,
      sizeBytes: 62_000_000,
      abi: 'arm64-v8a',
    });
  });

  it('universal + arm64: el universal en un móvil de 32 bits o si no se sabe la arquitectura', () => {
    expect(pickApkAsset([arm64Apk, universalApk], oldPhoneAbis)).toMatchObject({ fileName: universalApk.name });
    expect(pickApkAsset([arm64Apk, universalApk], null)).toMatchObject({ fileName: universalApk.name });
    expect(pickApkAsset([arm64Apk, universalApk], [])).toMatchObject({ fileName: universalApk.name });
  });

  it('con los tres APK, cada móvil recibe el suyo', () => {
    const allApks = [universalApk, armeabiApk, arm64Apk];
    expect(pickApkAsset(allApks, modernPhoneAbis)?.abi).toBe('arm64-v8a');
    expect(pickApkAsset(allApks, oldPhoneAbis)?.abi).toBe('armeabi-v7a');
    expect(pickApkAsset(allApks, ['x86_64', 'x86'])?.abi).toBeNull();
  });

  it('nunca elige un APK de otra arquitectura', () => {
    expect(pickApkAsset([arm64Apk], oldPhoneAbis)).toBeNull();
    expect(pickApkAsset([arm64Apk], null)).toBeNull();
  });

  it('nombres antiguos: el APK sin sufijo es el universal y los demás assets se ignoran', () => {
    const oldReleaseAssets = [
      { name: 'checksums.txt', browser_download_url: 'https://github.com/x/checksums.txt', size: 100 },
      releaseAsset('laboratorio-de-bolsillo-0.4.5.apk', 116_000_000),
    ];
    expect(pickApkAsset(oldReleaseAssets, modernPhoneAbis)).toMatchObject({
      fileName: 'laboratorio-de-bolsillo-0.4.5.apk',
      sizeBytes: 116_000_000,
      abi: null,
    });
  });

  it('ignora APK fuera de GitHub y listas no válidas', () => {
    expect(pickApkAsset([{ ...arm64Apk, browser_download_url: 'https://malicioso.example/a.apk' }], modernPhoneAbis)).toBeNull();
    expect(pickApkAsset('no es una lista', modernPhoneAbis)).toBeNull();
  });

  it('evaluateLatestRelease usa la arquitectura del móvil', () => {
    const updateCheckResult = evaluateLatestRelease(
      '0.4.5',
      { tag_name: 'v0.5.0', html_url: 'https://github.com/x', assets: [universalApk, arm64Apk] },
      modernPhoneAbis,
    );
    expect(updateCheckResult.status === 'update-available' && updateCheckResult.release).toMatchObject({
      apkDownloadUrl: arm64Apk.browser_download_url,
      apkSizeBytes: 62_000_000,
      apkAbi: 'arm64-v8a',
    });
  });
});
