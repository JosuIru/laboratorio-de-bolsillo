package expo.modules.wifisignal

import android.content.Context
import android.net.wifi.ScanResult
import android.net.wifi.SupplicantState
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.SystemClock
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Lecturas de Wi‑Fi para el mapa de cobertura: la conexión actual (RSSI, velocidad de enlace,
 * frecuencia y estándar) y el escaneo de redes vecinas. Todo son funciones síncronas y
 * baratas: JS las consulta cuando quiere (unas dos veces por segundo).
 */
class WifiSignalModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  private val wifiManager: WifiManager?
    get() = context.getSystemService(Context.WIFI_SERVICE) as? WifiManager

  override fun definition() = ModuleDefinition {
    Name("WifiSignal")

    Function("isWifiEnabled") {
      wifiManager?.isWifiEnabled ?: false
    }

    // Conexión actual o null si no hay Wi‑Fi conectado.
    Function("getConnectionInfo") {
      readConnectionInfo()
    }

    // Pide un escaneo. Android lo limita (4 cada 2 minutos en primer plano): devuelve false si
    // el sistema lo rechaza, y entonces getScanResults devuelve los resultados anteriores.
    Function("startScan") {
      requestScan()
    }

    // Últimos resultados de escaneo, o null si falta el permiso.
    Function("getScanResults") {
      readScanResults()
    }
  }

  @Suppress("DEPRECATION")
  private fun requestScan(): Boolean {
    return try {
      wifiManager?.startScan() ?: false
    } catch (securityException: SecurityException) {
      false
    }
  }

  private fun readConnectionInfo(): Map<String, Any?>? {
    val manager = wifiManager ?: return null
    if (!manager.isWifiEnabled) return null

    @Suppress("DEPRECATION")
    val wifiInfo: WifiInfo = manager.connectionInfo ?: return null
    val isConnected = wifiInfo.supplicantState == SupplicantState.COMPLETED && wifiInfo.frequency > 0
    if (!isConnected) return null

    @Suppress("DEPRECATION")
    val rawSsid = wifiInfo.ssid
    val ssid = rawSsid
      ?.takeIf { it != WifiManager.UNKNOWN_SSID && it.isNotBlank() }
      ?.removeSurrounding("\"")
    // Sin permiso de ubicación Android devuelve una MAC ficticia.
    val bssid = wifiInfo.bssid?.takeIf { it != "02:00:00:00:00:00" }

    return mapOf(
      "rssiDbm" to wifiInfo.rssi,
      "linkSpeedMbps" to wifiInfo.linkSpeed.takeIf { it > 0 },
      "txLinkSpeedMbps" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) wifiInfo.txLinkSpeedMbps.takeIf { it > 0 } else null,
      "rxLinkSpeedMbps" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) wifiInfo.rxLinkSpeedMbps.takeIf { it > 0 } else null,
      "maxLinkSpeedMbps" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) wifiInfo.maxSupportedTxLinkSpeedMbps.takeIf { it > 0 } else null,
      "frequencyMhz" to wifiInfo.frequency,
      "wifiStandard" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) wifiInfo.wifiStandard else null,
      "ssid" to ssid,
      "bssid" to bssid,
      "elapsedRealtimeMs" to SystemClock.elapsedRealtime().toDouble()
    )
  }

  private fun readScanResults(): List<Map<String, Any?>>? {
    val manager = wifiManager ?: return null
    val scanResults: List<ScanResult> = try {
      manager.scanResults ?: emptyList()
    } catch (securityException: SecurityException) {
      return null
    }
    val nowMicroseconds = SystemClock.elapsedRealtime() * 1000
    return scanResults.map { scanResult ->
      @Suppress("DEPRECATION")
      val ssid = scanResult.SSID?.takeIf { it.isNotBlank() }
      mapOf(
        "bssid" to (scanResult.BSSID ?: ""),
        "ssid" to ssid,
        "rssiDbm" to scanResult.level,
        "frequencyMhz" to scanResult.frequency,
        "centerFrequencyMhz" to scanResult.centerFreq0.takeIf { it > 0 },
        "channelWidthCode" to scanResult.channelWidth,
        "wifiStandard" to if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) scanResult.wifiStandard else null,
        "ageMs" to ((nowMicroseconds - scanResult.timestamp) / 1000).coerceAtLeast(0).toDouble()
      )
    }
  }
}
