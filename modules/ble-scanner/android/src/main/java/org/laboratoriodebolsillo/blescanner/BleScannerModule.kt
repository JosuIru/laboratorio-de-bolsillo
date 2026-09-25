package org.laboratoriodebolsillo.blescanner

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val advertisementBatchEventName = "onAdvertisementBatch"
private const val scanErrorEventName = "onScanError"

/** Cada cuánto se envía a JavaScript el lote de anuncios acumulados (un evento por anuncio saturaría el puente). */
private const val batchFlushIntervalMilliseconds = 250L

/** Tope del lote: si hay muchísimos dispositivos, se descartan los más antiguos del lote. */
private const val maximumAdvertisementsPerBatch = 400

class BluetoothUnavailableException : CodedException("ERR_BLUETOOTH_UNAVAILABLE", "Este dispositivo no tiene Bluetooth de baja energía", null)

class BluetoothDisabledException : CodedException("ERR_BLUETOOTH_DISABLED", "El Bluetooth está apagado", null)

class ScanPermissionException(cause: Throwable?) :
  CodedException("ERR_BLUETOOTH_PERMISSION", "Falta el permiso para buscar dispositivos Bluetooth", cause)

/**
 * Escaneo BLE pasivo: solo escucha anuncios, nunca se conecta a nada. Por cada anuncio entrega
 * la dirección, el RSSI, los datos de fabricante (company id + bytes), los UUID de servicio, los
 * datos de servicio y la marca de tiempo del sistema. La interpretación se hace en JavaScript.
 */
class BleScannerModule : Module() {
  private val mainHandler = Handler(Looper.getMainLooper())
  private val pendingAdvertisements = ArrayList<Map<String, Any?>>()
  private val pendingAdvertisementsLock = Any()
  @Volatile private var activeScanCallback: ScanCallback? = null

  private val flushRunnable = object : Runnable {
    override fun run() {
      flushPendingAdvertisements()
      if (activeScanCallback != null) mainHandler.postDelayed(this, batchFlushIntervalMilliseconds)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("BleScanner")

    Events(advertisementBatchEventName, scanErrorEventName)

    Function("isBluetoothLowEnergyAvailable") {
      val context = appContext.reactContext ?: return@Function false
      context.packageManager.hasSystemFeature("android.hardware.bluetooth_le") && findBluetoothAdapter() != null
    }

    Function("isBluetoothEnabled") {
      findBluetoothAdapter()?.isEnabled == true
    }

    Function("isScanning") {
      activeScanCallback != null
    }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, *requiredScanPermissions())
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, *requiredScanPermissions())
    }

    Function("startScan") {
      startScan()
    }

    Function("stopScan") {
      stopScan()
    }

    OnStopObserving(advertisementBatchEventName) {
      stopScan()
    }

    OnActivityEntersBackground {
      stopScan()
    }

    OnDestroy {
      stopScan()
    }
  }

  /** Android 12+ usa BLUETOOTH_SCAN (con neverForLocation); antes, el escaneo exige ubicación precisa. */
  private fun requiredScanPermissions(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      arrayOf(Manifest.permission.BLUETOOTH_SCAN)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  private fun findBluetoothAdapter(): BluetoothAdapter? {
    val context = appContext.reactContext ?: return null
    val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    return bluetoothManager?.adapter
  }

  @SuppressLint("MissingPermission")
  private fun startScan() {
    if (activeScanCallback != null) return
    val bluetoothAdapter = findBluetoothAdapter() ?: throw BluetoothUnavailableException()
    if (!bluetoothAdapter.isEnabled) throw BluetoothDisabledException()
    val bluetoothLeScanner = bluetoothAdapter.bluetoothLeScanner ?: throw BluetoothDisabledException()

    val scanSettings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
      .setMatchMode(ScanSettings.MATCH_MODE_AGGRESSIVE)
      .setReportDelay(0)
      .build()

    val scanCallback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        enqueueAdvertisement(result)
      }

      override fun onBatchScanResults(results: MutableList<ScanResult>) {
        results.forEach { enqueueAdvertisement(it) }
      }

      override fun onScanFailed(errorCode: Int) {
        activeScanCallback = null
        mainHandler.removeCallbacks(flushRunnable)
        sendEvent(scanErrorEventName, mapOf("errorCode" to errorCode))
      }
    }

    try {
      // Sin filtros: los rastreadores usan firmas muy distintas y se clasifican en JavaScript.
      bluetoothLeScanner.startScan(null, scanSettings, scanCallback)
    } catch (securityException: SecurityException) {
      throw ScanPermissionException(securityException)
    }
    activeScanCallback = scanCallback
    mainHandler.postDelayed(flushRunnable, batchFlushIntervalMilliseconds)
  }

  @SuppressLint("MissingPermission")
  private fun stopScan() {
    val scanCallback = activeScanCallback ?: return
    activeScanCallback = null
    mainHandler.removeCallbacks(flushRunnable)
    try {
      findBluetoothAdapter()?.bluetoothLeScanner?.stopScan(scanCallback)
    } catch (_: SecurityException) {
      // Si se retiró el permiso con el escaneo en marcha, el sistema ya lo ha parado.
    } catch (_: IllegalStateException) {
      // El Bluetooth se apagó con el escaneo en marcha.
    }
    synchronized(pendingAdvertisementsLock) { pendingAdvertisements.clear() }
  }

  @SuppressLint("MissingPermission")
  private fun enqueueAdvertisement(result: ScanResult) {
    val scanRecord = result.scanRecord
    val manufacturerData = ArrayList<Map<String, Any>>()
    scanRecord?.manufacturerSpecificData?.let { manufacturerDataByCompany ->
      for (index in 0 until manufacturerDataByCompany.size()) {
        manufacturerData.add(
          mapOf(
            "companyId" to manufacturerDataByCompany.keyAt(index),
            "bytes" to manufacturerDataByCompany.valueAt(index).toUnsignedList(),
          ),
        )
      }
    }
    val serviceUuids = scanRecord?.serviceUuids?.map { it.uuid.toString().uppercase() } ?: emptyList()
    val serviceData = scanRecord?.serviceData?.map { (serviceUuid, bytes) ->
      mapOf("uuid" to serviceUuid.uuid.toString().uppercase(), "bytes" to bytes.toUnsignedList())
    } ?: emptyList()

    // timestampNanos va en el reloj de arranque: se pasa a tiempo Unix para JavaScript.
    val ageMilliseconds = (SystemClock.elapsedRealtimeNanos() - result.timestampNanos) / 1_000_000L
    val timestampMilliseconds = System.currentTimeMillis() - ageMilliseconds.coerceAtLeast(0L)

    val advertisement = mapOf(
      "address" to result.device.address,
      "rssi" to result.rssi,
      "timestampMilliseconds" to timestampMilliseconds.toDouble(),
      "manufacturerData" to manufacturerData,
      "serviceUuids" to serviceUuids,
      "serviceData" to serviceData,
      "localName" to scanRecord?.deviceName,
      "isConnectable" to result.isConnectable,
    )
    synchronized(pendingAdvertisementsLock) {
      if (pendingAdvertisements.size >= maximumAdvertisementsPerBatch) pendingAdvertisements.removeAt(0)
      pendingAdvertisements.add(advertisement)
    }
  }

  private fun flushPendingAdvertisements() {
    val advertisementBatch = synchronized(pendingAdvertisementsLock) {
      if (pendingAdvertisements.isEmpty()) return
      val batchCopy = ArrayList(pendingAdvertisements)
      pendingAdvertisements.clear()
      batchCopy
    }
    sendEvent(advertisementBatchEventName, mapOf("advertisements" to advertisementBatch))
  }
}

private fun ByteArray.toUnsignedList(): List<Int> = map { it.toInt() and 0xFF }
