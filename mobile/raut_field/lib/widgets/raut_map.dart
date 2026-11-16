import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart' as gm;
import 'package:latlong2/latlong.dart' as ll;

import '../core/config.dart';
import '../core/map_links.dart';
import '../theme.dart';

/// A pin on the map. Mirrors the console's `MapPoint`: same tones, same
/// numbered-stop treatment, so a rep and the office look at the same picture.
class RautMapPoint {
  const RautMapPoint({
    required this.id,
    required this.lat,
    required this.lng,
    required this.label,
    this.sequence,
    this.tone = RautMapTone.neutral,
  });

  final String id;
  final double lat;
  final double lng;
  final String label;
  final int? sequence;
  final RautMapTone tone;
}

enum RautMapTone { neutral, success, warning, danger }

Color _toneColour(RautMapTone tone) => switch (tone) {
      RautMapTone.neutral => RautTheme.brand,
      RautMapTone.success => RautTheme.success,
      RautMapTone.warning => RautTheme.warning,
      RautMapTone.danger => RautTheme.danger,
    };

/// Which basemap this handset can actually draw for a company's choice.
///
/// The company's administrator chose the provider (`Session.mapProvider`).
/// Google's Android SDK additionally needs a key compiled into the APK
/// (`--dart-define=GOOGLE_MAPS_ANDROID_KEY=…`); a build without one shows
/// OpenStreetMap even when Google was chosen, rather than a blank panel.
/// Directions links still follow the company's choice — they open the rep's
/// own maps app, which needs no key of ours.
String effectiveMapProvider(String? provider) {
  final wanted = MapLinks.normalise(provider);
  if (wanted == MapLinks.google && !AppConfig.hasGoogleMapsKey) return MapLinks.osm;
  return wanted;
}

/// The field app's map. OpenStreetMap through flutter_map, or Google Maps
/// through the Maps SDK, chosen by the company's administrator in the console.
class RautMap extends StatelessWidget {
  const RautMap({
    super.key,
    required this.provider,
    required this.points,
    this.path = const [],
    this.circleRadiusM,
    this.height = 220,
    this.interactive = true,
  });

  /// `GOOGLE` or `OSM`, as the session carries it.
  final String? provider;
  final List<RautMapPoint> points;

  /// Ids of points to join in order — a route's stop sequence.
  final List<String> path;

  /// Draws a fence of this radius around a single point (the check-in range).
  final double? circleRadiusM;
  final double height;
  final bool interactive;

  @override
  Widget build(BuildContext context) {
    if (points.isEmpty) {
      return _frame(
        Center(
          child: Text(
            'No GPS pins to show',
            style: TextStyle(color: RautTheme.textMuted),
          ),
        ),
      );
    }

    final effective = effectiveMapProvider(provider);
    final child = effective == MapLinks.google ? _google() : _osm();
    return _frame(child);
  }

  Widget _frame(Widget child) => ClipRRect(
        borderRadius: BorderRadius.circular(14),
        child: SizedBox(height: height, width: double.infinity, child: child),
      );

  _Bounds get _bounds => _Bounds.of(points);

  List<RautMapPoint> get _pathPoints {
    final byId = {for (final p in points) p.id: p};
    return [for (final id in path) if (byId[id] != null) byId[id]!];
  }

  // ── OpenStreetMap ───────────────────────────────────────────────────

  Widget _osm() {
    final b = _bounds;
    final fit = points.length == 1
        ? CameraFit.coordinates(
            coordinates: [ll.LatLng(points.first.lat, points.first.lng)],
            maxZoom: circleRadiusM != null ? 16 : 15,
          )
        : CameraFit.bounds(
            bounds: LatLngBounds(ll.LatLng(b.south, b.west), ll.LatLng(b.north, b.east)),
            padding: const EdgeInsets.all(32),
          );

    return FlutterMap(
      options: MapOptions(
        initialCameraFit: fit,
        interactionOptions: InteractionOptions(
          flags: interactive ? InteractiveFlag.all & ~InteractiveFlag.rotate : InteractiveFlag.none,
        ),
      ),
      children: [
        TileLayer(
          urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          // OSM's tile usage policy requires an identifying user agent.
          userAgentPackageName: 'com.raut.app',
          maxZoom: 19,
        ),
        if (circleRadiusM != null && points.length == 1)
          CircleLayer(
            circles: [
              CircleMarker(
                point: ll.LatLng(points.first.lat, points.first.lng),
                radius: circleRadiusM!,
                useRadiusInMeter: true,
                color: _toneColour(points.first.tone).withValues(alpha: 0.12),
                borderColor: _toneColour(points.first.tone),
                borderStrokeWidth: 1.5,
              ),
            ],
          ),
        if (_pathPoints.length > 1)
          PolylineLayer(
            polylines: [
              Polyline(
                points: [for (final p in _pathPoints) ll.LatLng(p.lat, p.lng)],
                color: RautTheme.brand.withValues(alpha: 0.85),
                strokeWidth: 3.5,
                pattern: StrokePattern.dashed(segments: const [9, 6]),
              ),
            ],
          ),
        MarkerLayer(
          markers: [
            for (final p in points)
              Marker(
                point: ll.LatLng(p.lat, p.lng),
                width: p.sequence != null ? 26 : 16,
                height: p.sequence != null ? 26 : 16,
                child: _Pin(point: p),
              ),
          ],
        ),
        const RichAttributionWidget(
          alignment: AttributionAlignment.bottomLeft,
          showFlutterMapAttribution: false,
          attributions: [TextSourceAttribution('© OpenStreetMap contributors')],
        ),
      ],
    );
  }

  // ── Google Maps ─────────────────────────────────────────────────────

  Widget _google() {
    final b = _bounds;
    final markers = <gm.Marker>{
      for (final p in points)
        gm.Marker(
          markerId: gm.MarkerId(p.id),
          position: gm.LatLng(p.lat, p.lng),
          infoWindow: gm.InfoWindow(
            title: p.label,
            snippet: p.sequence != null ? 'Stop ${p.sequence}' : null,
          ),
          icon: gm.BitmapDescriptor.defaultMarkerWithHue(_hue(p.tone)),
        ),
    };

    final polylines = <gm.Polyline>{
      if (_pathPoints.length > 1)
        gm.Polyline(
          polylineId: const gm.PolylineId('route'),
          points: [for (final p in _pathPoints) gm.LatLng(p.lat, p.lng)],
          color: RautTheme.brand,
          width: 4,
          patterns: [gm.PatternItem.dash(18), gm.PatternItem.gap(10)],
        ),
    };

    final circles = <gm.Circle>{
      if (circleRadiusM != null && points.length == 1)
        gm.Circle(
          circleId: const gm.CircleId('fence'),
          center: gm.LatLng(points.first.lat, points.first.lng),
          radius: circleRadiusM!,
          fillColor: _toneColour(points.first.tone).withValues(alpha: 0.12),
          strokeColor: _toneColour(points.first.tone),
          strokeWidth: 2,
        ),
    };

    return gm.GoogleMap(
      initialCameraPosition: gm.CameraPosition(
        target: gm.LatLng(b.centreLat, b.centreLng),
        zoom: points.length == 1 ? 15 : 12,
      ),
      markers: markers,
      polylines: polylines,
      circles: circles,
      myLocationButtonEnabled: false,
      zoomControlsEnabled: false,
      mapToolbarEnabled: false,
      scrollGesturesEnabled: interactive,
      zoomGesturesEnabled: interactive,
      rotateGesturesEnabled: false,
      tiltGesturesEnabled: false,
      onMapCreated: (controller) {
        if (points.length > 1) {
          controller.animateCamera(
            gm.CameraUpdate.newLatLngBounds(
              gm.LatLngBounds(
                southwest: gm.LatLng(b.south, b.west),
                northeast: gm.LatLng(b.north, b.east),
              ),
              40,
            ),
          );
        }
      },
    );
  }

  static double _hue(RautMapTone tone) => switch (tone) {
        RautMapTone.neutral => gm.BitmapDescriptor.hueAzure,
        RautMapTone.success => gm.BitmapDescriptor.hueGreen,
        RautMapTone.warning => gm.BitmapDescriptor.hueOrange,
        RautMapTone.danger => gm.BitmapDescriptor.hueRed,
      };
}

class _Pin extends StatelessWidget {
  const _Pin({required this.point});

  final RautMapPoint point;

  @override
  Widget build(BuildContext context) {
    final colour = _toneColour(point.tone);
    final seq = point.sequence;
    return Container(
      decoration: BoxDecoration(
        color: colour,
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2),
        boxShadow: const [BoxShadow(color: Colors.black26, blurRadius: 4, offset: Offset(0, 1))],
      ),
      alignment: Alignment.center,
      child: seq == null
          ? null
          : Text(
              '$seq',
              style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w700),
            ),
    );
  }
}

class _Bounds {
  const _Bounds(this.north, this.south, this.east, this.west);

  final double north, south, east, west;

  double get centreLat => (north + south) / 2;
  double get centreLng => (east + west) / 2;

  static _Bounds of(List<RautMapPoint> points) {
    var north = -90.0, south = 90.0, east = -180.0, west = 180.0;
    for (final p in points) {
      if (p.lat > north) north = p.lat;
      if (p.lat < south) south = p.lat;
      if (p.lng > east) east = p.lng;
      if (p.lng < west) west = p.lng;
    }
    // A single point or a degenerate line still needs a non-zero box.
    if (north - south < 0.002) {
      north += 0.001;
      south -= 0.001;
    }
    if (east - west < 0.002) {
      east += 0.001;
      west -= 0.001;
    }
    return _Bounds(north, south, east, west);
  }
}
