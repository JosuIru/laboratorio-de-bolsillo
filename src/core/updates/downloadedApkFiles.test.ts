import {
  applicationIdFromContentUri,
  downloadedApkFileName,
  isDownloadedApkComplete,
  isDownloadedFileObsolete,
  parseDownloadedApkVersion,
} from './downloadedApkFiles';

describe('downloadedApkFileName / parseDownloadedApkVersion', () => {
  it('un fichero por versión, y se puede leer la versión del nombre', () => {
    expect(downloadedApkFileName('0.5.0')).toBe('laboratorio-de-bolsillo-0.5.0.apk');
    expect(parseDownloadedApkVersion('laboratorio-de-bolsillo-0.5.0.apk')).toBe('0.5.0');
  });

  it.each(['laboratorio-de-bolsillo-0.5.0.apk.part', 'otra-app-0.5.0.apk', 'laboratorio-de-bolsillo-nueva.apk'])(
    'no reconoce %s',
    (unknownFileName) => {
      expect(parseDownloadedApkVersion(unknownFileName)).toBeNull();
    },
  );
});

describe('isDownloadedFileObsolete', () => {
  it('borra el APK de la versión ya instalada o de una anterior', () => {
    expect(isDownloadedFileObsolete('laboratorio-de-bolsillo-0.4.5.apk', '0.4.5')).toBe(true);
    expect(isDownloadedFileObsolete('laboratorio-de-bolsillo-0.4.4.apk', '0.4.5')).toBe(true);
  });

  it('conserva el APK de una versión más nueva, pendiente de instalar', () => {
    expect(isDownloadedFileObsolete('laboratorio-de-bolsillo-0.5.0.apk', '0.4.5')).toBe(false);
  });

  it('borra descargas a medias y ficheros desconocidos', () => {
    expect(isDownloadedFileObsolete('laboratorio-de-bolsillo-0.5.0.apk.part', '0.4.5')).toBe(true);
    expect(isDownloadedFileObsolete('basura.tmp', '0.4.5')).toBe(true);
  });
});

describe('isDownloadedApkComplete', () => {
  it('compara con el tamaño del asset', () => {
    expect(isDownloadedApkComplete(116_000_000, 116_000_000)).toBe(true);
    expect(isDownloadedApkComplete(58_000_000, 116_000_000)).toBe(false);
    expect(isDownloadedApkComplete(0, null)).toBe(false);
    expect(isDownloadedApkComplete(1_000, null)).toBe(true);
  });
});

describe('applicationIdFromContentUri', () => {
  it('saca el id de la autoridad del FileProvider', () => {
    expect(
      applicationIdFromContentUri(
        'content://org.laboratoriodebolsillo.app.dev.FileSystemFileProvider/cached_expo_files/updates/x.apk',
      ),
    ).toBe('org.laboratoriodebolsillo.app.dev');
    expect(applicationIdFromContentUri('file:///data/user/0/x/cache/x.apk')).toBeNull();
  });
});
