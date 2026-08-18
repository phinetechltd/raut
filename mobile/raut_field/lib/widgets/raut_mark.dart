import 'package:flutter/material.dart';

/// The Raut mark.
///
/// Renders the supplied brand artwork from `assets/brand/`. An earlier version
/// reproduced the mark with a CustomPainter, which drifted from the real logo —
/// the artwork is the source of truth, so it is displayed, not redrawn.
///
/// The PNGs carry transparency outside the rounded square, so they sit cleanly
/// on any background without a plate behind them.
class RautMark extends StatelessWidget {
  const RautMark({super.key, this.size = 56});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/brand/raut-icon.png',
      width: size,
      height: size,
      filterQuality: FilterQuality.high,
      // Named so a missing asset is obvious in the tree rather than an
      // invisible gap someone has to hunt for.
      semanticLabel: 'Raut',
    );
  }
}

/// The full lockup with the strapline, for the login screen and about surfaces.
class RautLockup extends StatelessWidget {
  const RautLockup({super.key, this.size = 200});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Image.asset(
      'assets/brand/raut-logo-tagline.png',
      width: size,
      height: size,
      filterQuality: FilterQuality.high,
      semanticLabel: 'Raut — Building trust in operations',
    );
  }
}

/// Mark plus wordmark text, for headers where the lockup would be too large.
class RautWordmark extends StatelessWidget {
  const RautWordmark({super.key, this.markSize = 48, this.showTagline = true});

  final double markSize;
  final bool showTagline;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        RautMark(size: markSize),
        SizedBox(width: markSize * 0.24),
        Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Raut',
              style: TextStyle(
                fontSize: markSize * 0.56,
                fontWeight: FontWeight.w700,
                letterSpacing: -0.5,
                height: 1,
              ),
            ),
            if (showTagline) ...[
              SizedBox(height: markSize * 0.08),
              Text(
                'One Platform. Every Mile.',
                style: TextStyle(
                  fontSize: markSize * 0.17,
                  color: Colors.grey.shade600,
                  height: 1.1,
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }
}
