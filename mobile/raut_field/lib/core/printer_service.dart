import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// The thermal printer on an Android POS.
///
/// The layout lives in Dart (see `receipt.dart`) and only the marks-on-paper
/// commands cross the channel. That keeps the receipt previewable on screen
/// from the same source that prints it, so what a rep sees is what the customer
/// is handed — a receipt that only exists once printed cannot be checked.
///
/// A handset with no printer is a normal state, not an error: reps run this app
/// on plain phones as well as on POS hardware. `available` is false there and
/// the print buttons are simply absent.
class PrinterService extends ChangeNotifier {
  static const _channel = MethodChannel('co.ke.raut/printer');

  bool _available = false;
  bool get available => _available;

  bool _checked = false;
  bool get checked => _checked;

  Map<String, String>? _info;
  Map<String, String>? get info => _info;

  bool _printing = false;
  bool get printing => _printing;

  /// Asks the platform whether a printer is bound.
  ///
  /// Safe on iOS and on a desktop test host: a MissingPluginException means
  /// there is no printer, which is exactly what we want to record.
  Future<void> probe() async {
    try {
      _available = await _channel.invokeMethod<bool>('isAvailable') ?? false;
      if (_available) {
        final raw = await _channel.invokeMapMethod<String, dynamic>('printerInfo');
        _info = raw?.map((k, v) => MapEntry(k, '$v'));
      }
    } on MissingPluginException {
      _available = false;
    } on PlatformException {
      _available = false;
    } finally {
      _checked = true;
      notifyListeners();
    }
  }

  /// Sends one receipt.
  ///
  /// Returns the failure reason rather than throwing. A print failure at a
  /// counter is an ordinary event — out of paper, cover open, service
  /// restarted — and the sale it belongs to has already completed. Nothing
  /// upstream should be unwound because a receipt did not come out.
  Future<String?> print(List<Map<String, Object?>> ops) async {
    if (!_available) return 'No printer on this device';

    _printing = true;
    notifyListeners();
    try {
      await _channel.invokeMethod<bool>('print', {'ops': ops});
      return null;
    } on PlatformException catch (e) {
      return e.message ?? 'The printer refused the job';
    } on MissingPluginException {
      return 'No printer on this device';
    } finally {
      _printing = false;
      notifyListeners();
    }
  }
}

/// Builders for the printer operations the platform channel understands.
///
/// Free functions rather than a class: a receipt is a list of instructions, and
/// reading one top to bottom should look like the paper it produces.
class Op {
  static Map<String, Object?> text(
    String value, {
    String align = 'left',
    double size = 24,
    bool bold = false,
  }) =>
      {'type': 'text', 'text': value, 'align': align, 'size': size, 'bold': bold};

  /// A row of columns. Widths are in character cells, not pixels.
  static Map<String, Object?> columns(
    List<String> values,
    List<int> widths, {
    List<int>? aligns,
  }) =>
      {
        'type': 'columns',
        'columns': values,
        'widths': widths,
        'aligns': aligns ?? List<int>.filled(values.length, 0),
      };

  static Map<String, Object?> qr(String data, {int size = 5}) =>
      {'type': 'qr', 'data': data, 'size': size, 'errorLevel': 2};

  static Map<String, Object?> barcode(String data) =>
      {'type': 'barcode', 'data': data, 'symbology': 8, 'height': 80, 'width': 2};

  static Map<String, Object?> feed([int lines = 1]) =>
      {'type': 'feed', 'lines': lines};
}
