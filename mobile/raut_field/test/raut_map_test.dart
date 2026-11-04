import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:raut_field/widgets/raut_map.dart';

/// The in-app map follows the company's provider setting, but only as far as
/// the build allows: Google needs an Android SDK key compiled in, and the
/// test binary (like any build made without --dart-define) has none.
void main() {
  group('effectiveMapProvider', () {
    test('OpenStreetMap is honoured as chosen', () {
      expect(effectiveMapProvider('OSM'), 'OSM');
      expect(effectiveMapProvider(null), 'OSM');
    });

    test('Google without a compiled-in key degrades to OpenStreetMap', () {
      expect(effectiveMapProvider('GOOGLE'), 'OSM');
      expect(effectiveMapProvider('google'), 'OSM');
    });
  });

  group('RautMap', () {
    const nairobi = RautMapPoint(id: 'a', lat: -1.2864, lng: 36.8172, label: 'Nairobi CBD');

    testWidgets('renders an OpenStreetMap tile map for the OSM provider', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: RautMap(provider: 'OSM', points: [nairobi])),
      ));
      expect(find.byType(FlutterMap), findsOneWidget);
    });

    testWidgets('a Google choice without a key still draws a map, on OpenStreetMap', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: RautMap(provider: 'GOOGLE', points: [nairobi])),
      ));
      expect(find.byType(FlutterMap), findsOneWidget);
    });

    testWidgets('says so rather than drawing an empty map when nothing is pinned', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(body: RautMap(provider: 'OSM', points: [])),
      ));
      expect(find.text('No GPS pins to show'), findsOneWidget);
      expect(find.byType(FlutterMap), findsNothing);
    });

    testWidgets('numbered stops render their sequence on the pin', (tester) async {
      await tester.pumpWidget(const MaterialApp(
        home: Scaffold(
          body: RautMap(
            provider: 'OSM',
            points: [
              RautMapPoint(id: 'a', lat: -1.2864, lng: 36.8172, label: 'A', sequence: 1),
              RautMapPoint(id: 'b', lat: -1.2964, lng: 36.8272, label: 'B', sequence: 2),
            ],
            path: ['a', 'b'],
          ),
        ),
      ));
      await tester.pump();
      expect(find.text('1'), findsOneWidget);
      expect(find.text('2'), findsOneWidget);
    });
  });
}
