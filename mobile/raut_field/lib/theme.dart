import 'package:flutter/material.dart';

/// Raut theme for the field app.
///
/// The palette is the same one the console uses — sampled from the logo and
/// contrast-checked there (platform/src/lib/design-tokens.ts). Keeping the two
/// in step matters because a rep and their manager look at the same numbers on
/// different screens; if the products look unrelated, they feel unrelated.
///
/// Two deliberate divergences from the console, both driven by where this app
/// is actually used — outdoors, in bright sun, one-handed:
///
///   - larger minimum tap targets than a desktop UI needs
///   - heavier type weights and higher contrast than the web defaults
class RautTheme {
  const RautTheme._();

  // ── brand ramp, matching the console ────────────────────────────────
  static const brand50 = Color(0xFFECFAFD);
  static const brand100 = Color(0xFFD0F1F8);
  static const brand300 = Color(0xFF6FD5E8);
  static const brand400 = Color(0xFF33C4DD);
  static const brand500 = Color(0xFF0AB6D6); // sampled from the logo arm
  static const brand600 = Color(0xFF076C80); // interactive: white passes AA
  static const brand700 = Color(0xFF075868);

  /// Call sites that just want "the brand colour" get the interactive step,
  /// because that is the one white text passes contrast against.
  static const brand = brand600;

  // ── blue-cast neutrals ──────────────────────────────────────────────
  static const slate50 = Color(0xFFF6F8FB);
  static const slate100 = Color(0xFFECEFF5);
  static const slate200 = Color(0xFFDCE2EC);
  static const slate300 = Color(0xFFC2CBDA);
  static const slate400 = Color(0xFF94A0B8);
  static const slate500 = Color(0xFF6B7A96);
  static const slate600 = Color(0xFF4E5C78);
  static const slate900 = Color(0xFF0B2136);
  static const ink = Color(0xFF052744); // the RAUT wordmark's navy

  // ── status ──────────────────────────────────────────────────────────
  /// The location pin's green. A brand gesture, never a status —
  /// `success` has to keep meaning exactly one thing.
  static const accentGreen = Color(0xFF43CC18);
  static const accentGreenDark = Color(0xFF2A8110);

  static const success = Color(0xFF047857);
  static const successBg = Color(0xFFECFDF5);
  static const warning = Color(0xFFB45309);
  static const warningBg = Color(0xFFFFFBEB);
  static const danger = Color(0xFFB91C1C);
  static const dangerBg = Color(0xFFFEF2F2);

  static const surface = Color(0xFFFFFFFF);
  static const background = slate50;
  static const border = Color(0xFFE3E8F0);
  static const text = Color(0xFF0F1729);

  /// Comfortable target for a thumb on a moving matatu — above the 48dp
  /// Material minimum, because the failure mode here is a mis-tapped order.
  static const double tapTarget = 52;

  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(
      seedColor: brand500,
      brightness: Brightness.light,
    ).copyWith(
      primary: brand600,
      onPrimary: Colors.white,
      secondary: brand400,
      surface: surface,
      onSurface: text,
      error: danger,
      outline: border,
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: background,

      appBarTheme: const AppBarTheme(
        centerTitle: false,
        elevation: 0,
        scrolledUnderElevation: 1,
        backgroundColor: surface,
        foregroundColor: text,
        surfaceTintColor: Colors.transparent,
        titleTextStyle: TextStyle(
          color: text,
          fontSize: 18,
          fontWeight: FontWeight.w600,
        ),
      ),

      cardTheme: CardThemeData(
        elevation: 0,
        color: surface,
        surfaceTintColor: Colors.transparent,
        margin: EdgeInsets.zero,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(14),
          side: const BorderSide(color: border),
        ),
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: brand600,
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(tapTarget),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: text,
          minimumSize: const Size.fromHeight(tapTarget),
          side: const BorderSide(color: border),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          textStyle: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
        ),
      ),

      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(foregroundColor: brand600),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surface,
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 16),
        border: _fieldBorder(border),
        enabledBorder: _fieldBorder(border),
        focusedBorder: _fieldBorder(brand500, width: 2),
        errorBorder: _fieldBorder(danger),
        focusedErrorBorder: _fieldBorder(danger, width: 2),
        labelStyle: const TextStyle(color: slate600),
        hintStyle: const TextStyle(color: slate500),
      ),

      chipTheme: ChipThemeData(
        side: BorderSide.none,
        backgroundColor: slate100,
        selectedColor: brand50,
        // The colour must be a WidgetStateColor *inside* a plain TextStyle, not
        // a WidgetStateTextStyle wrapping the whole thing: RawChip merges the
        // label style before resolving it, and merging flattens a
        // WidgetStateTextStyle to its own (null) fields. The colour then fell
        // through to an inherited white, so "Owing money" rendered white on
        // slate-100 — a 1.13 ratio, an apparently empty pill. RawChip does
        // resolve `labelStyle.color` as a state property, so this path holds.
        labelStyle: TextStyle(
          fontSize: 13,
          fontWeight: FontWeight.w600,
          color: WidgetStateColor.resolveWith(
            (states) => states.contains(WidgetState.selected) ? brand700 : slate600,
          ),
        ),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      ),

      listTileTheme: const ListTileThemeData(
        contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        titleTextStyle: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: text),
        subtitleTextStyle: TextStyle(fontSize: 13, color: slate600),
      ),

      dividerTheme: const DividerThemeData(color: border, space: 1, thickness: 1),

      navigationBarTheme: NavigationBarThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        indicatorColor: brand50,
        elevation: 2,
        height: 68,
        labelTextStyle: WidgetStateProperty.resolveWith(
          (states) => TextStyle(
            fontSize: 12,
            fontWeight: states.contains(WidgetState.selected)
                ? FontWeight.w600
                : FontWeight.w500,
            color: states.contains(WidgetState.selected) ? brand700 : slate600,
          ),
        ),
        iconTheme: WidgetStateProperty.resolveWith(
          (states) => IconThemeData(
            color: states.contains(WidgetState.selected) ? brand700 : slate500,
            size: 24,
          ),
        ),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: slate900,
        contentTextStyle: const TextStyle(color: Colors.white, fontSize: 14),
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      ),

      bottomSheetTheme: const BottomSheetThemeData(
        backgroundColor: surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
        ),
      ),

      progressIndicatorTheme: const ProgressIndicatorThemeData(
        color: brand600,
        linearTrackColor: slate200,
      ),
    );
  }

  static OutlineInputBorder _fieldBorder(Color color, {double width = 1}) {
    return OutlineInputBorder(
      borderRadius: BorderRadius.circular(12),
      borderSide: BorderSide(color: color, width: width),
    );
  }

  /// Status → colour, in one place so a status cannot be amber on the route
  /// list and grey on the visit screen.
  static Color statusColor(String status) => switch (status) {
        'COMPLETED' || 'DONE' || 'PAID' || 'VERIFIED' || 'APPROVED' => success,
        'IN_PROGRESS' || 'ARRIVED' || 'ISSUED' || 'CONFIRMED' || 'SENT' => brand600,
        'SCHEDULED' || 'PENDING' || 'PARTIALLY_PAID' || 'SUBMITTED' => warning,
        'MISSED' || 'CANCELLED' || 'SKIPPED' || 'OVERDUE' || 'UNVERIFIED' => danger,
        _ => slate500,
      };

  static Color statusTint(String status) {
    final c = statusColor(status);
    if (c == success) return successBg;
    if (c == warning) return warningBg;
    if (c == danger) return dangerBg;
    if (c == brand600) return brand50;
    return slate100;
  }

  static String statusLabel(String status) =>
      status.replaceAll('_', ' ').toLowerCase();
}

/// Compact status pill, matching the console's badge.
class StatusChip extends StatelessWidget {
  const StatusChip(this.status, {super.key, this.icon});

  final String status;
  final IconData? icon;

  @override
  Widget build(BuildContext context) {
    final color = RautTheme.statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: RautTheme.statusTint(status),
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 13, color: color),
            const SizedBox(width: 4),
          ],
          Text(
            RautTheme.statusLabel(status),
            style: TextStyle(
              color: color,
              fontSize: 11.5,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
      ),
    );
  }
}

/// Section label above grouped content, matching the console's heading.
class SectionLabel extends StatelessWidget {
  const SectionLabel(this.text, {super.key});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 6),
      child: Text(
        text.toUpperCase(),
        style: const TextStyle(
          fontSize: 11,
          letterSpacing: 1,
          fontWeight: FontWeight.w700,
          color: RautTheme.slate500,
        ),
      ),
    );
  }
}
