import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

/// Driver for screenshot capture.
///
/// `adb screencap` cannot read Flutter's hardware SurfaceView on this emulator
/// — it returns the window beneath, which is why earlier attempts produced the
/// splash screen. Driving the app through `flutter drive` lets the engine
/// rasterise its own frames and hand the bytes back here, which is the only
/// reliable way to photograph a Flutter UI on Android.
///
///   flutter drive \
///     --driver=test_driver/integration_test.dart \
///     --target=integration_test/screenshots_test.dart \
///     -d emulator-5554 --dart-define=RAUT_API_BASE=http://10.0.2.2:3200
Future<void> main() async {
  await integrationDriver(
    onScreenshot: (String name, List<int> bytes, [Map<String, Object?>? args]) async {
      final file = File('screenshots/$name.png');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(bytes);
      stdout.writeln('  captured ${file.path} (${bytes.length} bytes)');
      return true;
    },
  );
}
