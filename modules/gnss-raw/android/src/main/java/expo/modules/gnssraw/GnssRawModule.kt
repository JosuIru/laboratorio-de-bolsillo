package expo.modules.gnssraw

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.GnssMeasurement
import android.location.GnssMeasurementRequest
import android.location.GnssMeasurementsEvent
import android.location.GnssStatus
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executor

private const val SATELLITE_STATUS_EVENT = "onSatelliteStatus"
private const val RAW_MEASUREMENTS_EVENT = "onRawMeasurements"
private const val RAW_MEASUREMENTS_STATUS_EVENT = "onRawMeasurementsStatus"
private const val ENGINE_STATE_EVENT = "onEngineState"
private const val LOCATION_FIX_EVENT = "onLocationFix"

private const val NANOSECONDS_PER_GPS_WEEK = 604_800_000_000_000L

class MissingFineLocationPermissionException :
  CodedException("ERR_GNSS_PERMISSION", "Hace falta el permiso de ubicación precisa (ACCESS_FINE_LOCATION)", null)

class LocationManagerUnavailableException :
  CodedException("ERR_GNSS_UNAVAILABLE", "Este dispositivo no tiene servicio de ubicación GNSS", null)

/**
 * Estado del receptor GNSS en crudo: satélites (GnssStatus) y, si el chip lo permite, medidas
 * crudas (GnssMeasurementsEvent) con AGC y multitrayecto.
 *
 * Android solo entrega el estado de los satélites mientras hay una petición de ubicación activa
 * con el proveedor GPS, así que `start()` pide también actualizaciones de posición a 1 Hz.
 */
class GnssRawModule : Module() {
  private var callbackThread: HandlerThread? = null
  private var statusCallback: GnssStatus.Callback? = null
  private var measurementsCallback: GnssMeasurementsEvent.Callback? = null
  private var locationListener: LocationListener? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val locationManager: LocationManager?
    get() = appContext.reactContext?.getSystemService(Context.LOCATION_SERVICE) as? LocationManager

  override fun definition() = ModuleDefinition {
    Name("GnssRaw")

    Events(
      SATELLITE_STATUS_EVENT,
      RAW_MEASUREMENTS_EVENT,
      RAW_MEASUREMENTS_STATUS_EVENT,
      ENGINE_STATE_EVENT,
      LOCATION_FIX_EVENT
    )

    Function("getCapabilities") { readCapabilities() }

    Function("start") { startListening() }

    Function("stop") { stopListening() }

    OnDestroy { stopListening() }
  }

  private fun hasFineLocationPermission(): Boolean =
    context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

  private fun readCapabilities(): Map<String, Any?> {
    val manager = locationManager
    val hasGnssHardware = context.packageManager.hasSystemFeature(PackageManager.FEATURE_LOCATION_GPS)
    val isLocationEnabled = when {
      manager == null -> false
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.P -> manager.isLocationEnabled
      else -> manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
    }
    val hardwareModelName =
      if (manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) manager.gnssHardwareModelName else null
    val yearOfHardware =
      if (manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) manager.gnssYearOfHardware else 0
    // Antes de Android 12 no hay forma de saberlo sin registrarse: `null` = desconocido.
    val hasRawMeasurements: Boolean? =
      if (manager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) manager.gnssCapabilities.hasMeasurements() else null
    return mapOf(
      "androidApiLevel" to Build.VERSION.SDK_INT,
      "hasGnssHardware" to hasGnssHardware,
      "isLocationEnabled" to isLocationEnabled,
      "hasFineLocationPermission" to hasFineLocationPermission(),
      "gnssHardwareModelName" to hardwareModelName,
      "gnssYearOfHardware" to yearOfHardware,
      "hasRawMeasurements" to hasRawMeasurements,
      "hasPerBandAutomaticGainControl" to (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    )
  }

  @Suppress("MissingPermission")
  private fun startListening() {
    if (statusCallback != null) return
    val manager = locationManager ?: throw LocationManagerUnavailableException()
    if (!hasFineLocationPermission()) throw MissingFineLocationPermissionException()

    val thread = HandlerThread("GnssRawCallbacks").also { it.start() }
    callbackThread = thread
    val handler = Handler(thread.looper)
    val executor = Executor { runnable -> handler.post(runnable) }

    val newStatusCallback = createStatusCallback()
    statusCallback = newStatusCallback
    manager.registerGnssStatusCallback(newStatusCallback, handler)

    val newMeasurementsCallback = createMeasurementsCallback()
    measurementsCallback = newMeasurementsCallback
    registerMeasurements(manager, newMeasurementsCallback, executor, handler)

    val newLocationListener = createLocationListener()
    locationListener = newLocationListener
    manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, newLocationListener, thread.looper)
  }

  @Suppress("MissingPermission")
  private fun registerMeasurements(
    manager: LocationManager,
    callback: GnssMeasurementsEvent.Callback,
    executor: Executor,
    handler: Handler
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // «Full tracking» desactiva el ciclo de trabajo del chip: medidas más continuas (más batería).
      try {
        val request = GnssMeasurementRequest.Builder().setFullTracking(true).build()
        manager.registerGnssMeasurementsCallback(request, executor, callback)
        return
      } catch (fullTrackingError: Exception) {
        // Algunos fabricantes lo rechazan: se registra sin pedirlo.
      }
    }
    manager.registerGnssMeasurementsCallback(callback, handler)
  }

  private fun stopListening() {
    val manager = locationManager
    statusCallback?.let { manager?.unregisterGnssStatusCallback(it) }
    measurementsCallback?.let { manager?.unregisterGnssMeasurementsCallback(it) }
    locationListener?.let { manager?.removeUpdates(it) }
    statusCallback = null
    measurementsCallback = null
    locationListener = null
    callbackThread?.quitSafely()
    callbackThread = null
  }

  private fun elapsedRealtimeSeconds(): Double = SystemClock.elapsedRealtimeNanos() / 1e9

  private fun createStatusCallback() = object : GnssStatus.Callback() {
    override fun onStarted() {
      sendEvent(ENGINE_STATE_EVENT, mapOf("state" to "started"))
    }

    override fun onStopped() {
      sendEvent(ENGINE_STATE_EVENT, mapOf("state" to "stopped"))
    }

    override fun onFirstFix(ttffMillis: Int) {
      sendEvent(ENGINE_STATE_EVENT, mapOf("state" to "firstFix", "timeToFirstFixMilliseconds" to ttffMillis))
    }

    override fun onSatelliteStatusChanged(status: GnssStatus) {
      val satellites = ArrayList<Map<String, Any?>>(status.satelliteCount)
      for (satelliteIndex in 0 until status.satelliteCount) {
        val carrierFrequencyHz: Double? =
          if (status.hasCarrierFrequencyHz(satelliteIndex)) status.getCarrierFrequencyHz(satelliteIndex).toDouble() else null
        val basebandCn0DbHz: Double? =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && status.hasBasebandCn0DbHz(satelliteIndex)) {
            status.getBasebandCn0DbHz(satelliteIndex).toDouble()
          } else {
            null
          }
        satellites.add(
          mapOf(
            "constellationType" to status.getConstellationType(satelliteIndex),
            "svid" to status.getSvid(satelliteIndex),
            "cn0DbHz" to status.getCn0DbHz(satelliteIndex).toDouble(),
            "basebandCn0DbHz" to basebandCn0DbHz,
            "elevationDegrees" to status.getElevationDegrees(satelliteIndex).toDouble(),
            "azimuthDegrees" to status.getAzimuthDegrees(satelliteIndex).toDouble(),
            "usedInFix" to status.usedInFix(satelliteIndex),
            "hasAlmanac" to status.hasAlmanacData(satelliteIndex),
            "hasEphemeris" to status.hasEphemerisData(satelliteIndex),
            "carrierFrequencyHz" to carrierFrequencyHz
          )
        )
      }
      sendEvent(
        SATELLITE_STATUS_EVENT,
        mapOf("elapsedRealtimeSeconds" to elapsedRealtimeSeconds(), "satellites" to satellites)
      )
    }
  }

  private fun createMeasurementsCallback() = object : GnssMeasurementsEvent.Callback() {
    // Obsoleto desde Android 12 (allí se usa `hasRawMeasurements` de getCapabilities), pero útil antes.
    @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
    override fun onStatusChanged(status: Int) {
      val statusName = when (status) {
        GnssMeasurementsEvent.Callback.STATUS_READY -> "ready"
        GnssMeasurementsEvent.Callback.STATUS_NOT_SUPPORTED -> "notSupported"
        GnssMeasurementsEvent.Callback.STATUS_LOCATION_DISABLED -> "locationDisabled"
        GnssMeasurementsEvent.Callback.STATUS_NOT_ALLOWED -> "notAllowed"
        else -> "unknown"
      }
      sendEvent(RAW_MEASUREMENTS_STATUS_EVENT, mapOf("status" to statusName))
    }

    override fun onGnssMeasurementsReceived(event: GnssMeasurementsEvent) {
      val clock = event.clock
      // GPS time = timeNanos − (fullBiasNanos + biasNanos). La resta se hace con Long (el número
      // no cabe con precisión en un double) y solo se envía el tiempo de la semana.
      val receiverTimeOfWeekNanos: Double? = if (clock.hasFullBiasNanos()) {
        val gpsTimeNanos = clock.timeNanos - clock.fullBiasNanos
        val biasNanos = if (clock.hasBiasNanos()) clock.biasNanos else 0.0
        Math.floorMod(gpsTimeNanos, NANOSECONDS_PER_GPS_WEEK).toDouble() - biasNanos
      } else {
        null
      }
      val measurements = event.measurements.map { measurement -> measurementToMap(measurement) }
      val automaticGainControls: List<Map<String, Any?>> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
          event.gnssAutomaticGainControls.map { agc ->
            mapOf(
              "constellationType" to agc.constellationType,
              "carrierFrequencyHz" to agc.carrierFrequencyHz.toDouble(),
              "levelDb" to agc.levelDb
            )
          }
        } else {
          emptyList()
        }
      sendEvent(
        RAW_MEASUREMENTS_EVENT,
        mapOf(
          "elapsedRealtimeSeconds" to elapsedRealtimeSeconds(),
          "receiverTimeOfWeekNanos" to receiverTimeOfWeekNanos,
          "hardwareClockDiscontinuityCount" to clock.hardwareClockDiscontinuityCount,
          "measurements" to measurements,
          "automaticGainControls" to automaticGainControls
        )
      )
    }
  }

  @Suppress("DEPRECATION")
  private fun measurementToMap(measurement: GnssMeasurement): Map<String, Any?> {
    val automaticGainControlLevelDb: Double? =
      if (measurement.hasAutomaticGainControlLevelDb()) measurement.automaticGainControlLevelDb else null
    val carrierFrequencyHz: Double? =
      if (measurement.hasCarrierFrequencyHz()) measurement.carrierFrequencyHz.toDouble() else null
    return mapOf(
      "constellationType" to measurement.constellationType,
      "svid" to measurement.svid,
      "cn0DbHz" to measurement.cn0DbHz,
      "carrierFrequencyHz" to carrierFrequencyHz,
      "state" to measurement.state,
      "receivedSvTimeNanos" to measurement.receivedSvTimeNanos.toDouble(),
      "receivedSvTimeUncertaintyNanos" to measurement.receivedSvTimeUncertaintyNanos.toDouble(),
      "timeOffsetNanos" to measurement.timeOffsetNanos,
      "pseudorangeRateMetersPerSecond" to measurement.pseudorangeRateMetersPerSecond,
      "multipathIndicator" to measurement.multipathIndicator,
      "automaticGainControlLevelDb" to automaticGainControlLevelDb
    )
  }

  /** Se implementan todos los métodos: en Android < 11 no tienen implementación por defecto. */
  private fun createLocationListener() = object : LocationListener {
    override fun onLocationChanged(location: Location) {
      sendEvent(
        LOCATION_FIX_EVENT,
        mapOf(
          "elapsedRealtimeSeconds" to elapsedRealtimeSeconds(),
          "horizontalAccuracyMeters" to (if (location.hasAccuracy()) location.accuracy.toDouble() else null)
        )
      )
    }

    @Suppress("OVERRIDE_DEPRECATION")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) = Unit

    override fun onProviderEnabled(provider: String) = Unit

    override fun onProviderDisabled(provider: String) = Unit
  }
}
