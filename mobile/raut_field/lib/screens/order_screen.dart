import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/money.dart';
import '../data/field_repository.dart';
import '../models/models.dart';
import '../theme.dart';

/// Offline order capture.
///
/// Totals are computed on the handset with the same maths the server uses, so
/// the figure the rep reads out to the shopkeeper is the figure that will
/// appear on the invoice. A client that guesses and lets the server "correct"
/// it later produces exactly the argument this product exists to prevent.
class OrderScreen extends StatefulWidget {
  const OrderScreen({super.key, required this.customer, this.visitId});

  final Customer customer;
  final String? visitId;

  @override
  State<OrderScreen> createState() => _OrderScreenState();
}

class _OrderScreenState extends State<OrderScreen> {
  final _search = TextEditingController();
  final _note = TextEditingController();
  final Map<String, CartLine> _cart = {};

  /// Selling units by product id.
  Map<String, List<ProductVariant>> _variants = const {};

  /// Which unit the rep has picked, per product, for this visit.
  final Map<String, String> _chosenVariant = {};

  List<Product> _products = const [];
  bool _loading = true;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _loadProducts();
  }

  @override
  void dispose() {
    _search.dispose();
    _note.dispose();
    super.dispose();
  }

  Future<void> _loadProducts() async {
    final repo = context.read<FieldRepository>();
    final products = await repo.products(search: _search.text);
    // Loaded once for the whole catalogue rather than per row.
    final variants = await repo.variantsByProduct();
    if (!mounted) return;
    setState(() {
      _products = products;
      _variants = variants;
      _loading = false;
    });
  }

  int get _subtotal => _cart.values.fold(0, (s, l) => s + l.netCents);
  int get _tax => _cart.values.fold(0, (s, l) => s + l.taxCents);
  int get _total => _cart.values.fold(0, (s, l) => s + l.totalCents);

  /// Cart key. A product sold two ways is two lines: a customer taking a
  /// carton and two singles has bought them at different prices, and merging
  /// them would silently reprice one.
  String _key(Product product, ProductVariant? variant) =>
      variant == null ? product.id : '${product.id}:${variant.id}';

  void _setQuantity(Product product, ProductVariant? variant, int quantity) {
    final key = _key(product, variant);
    setState(() {
      if (quantity <= 0) {
        _cart.remove(key);
      } else {
        final existing = _cart[key];
        if (existing != null) {
          existing.quantity = quantity;
        } else {
          _cart[key] = CartLine(product: product, variant: variant, quantity: quantity);
        }
      }
    });
  }

  /// Which selling unit is showing for a product. Defaults to the one marked
  /// default, then to the smallest, so a rep who never touches the selector
  /// still sells singles rather than whatever the query returned first.
  ProductVariant? _selected(Product product) {
    final options = _variants[product.id] ?? const <ProductVariant>[];
    if (options.isEmpty) return null;
    final chosen = _chosenVariant[product.id];
    if (chosen != null) {
      for (final v in options) {
        if (v.id == chosen) return v;
      }
    }
    for (final v in options) {
      if (v.isDefault) return v;
    }
    return options.first;
  }

  Future<void> _save() async {
    if (_cart.isEmpty) return;

    // Resolved up front so the credit-limit dialog's await cannot leave this
    // reaching for a disposed BuildContext.
    final repo = context.read<FieldRepository>();

    // Credit control at the point of sale, where it can still change the
    // outcome. Not a hard block — the rep may have a manager's approval the
    // handset knows nothing about — but they must decide knowingly.
    if (widget.customer.creditLimitCents > 0 &&
        widget.customer.balanceCents + _total > widget.customer.creditLimitCents) {
      final proceed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          icon: const Icon(Icons.warning_amber_rounded,
              color: RautTheme.warning, size: 36),
          title: const Text('Over credit limit'),
          content: Text(
            'This order takes ${widget.customer.name} to '
            '${Money.format(widget.customer.balanceCents + _total)} against a '
            'limit of ${Money.format(widget.customer.creditLimitCents)}.\n\n'
            'Continue only if this has been approved.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Place anyway'),
            ),
          ],
        ),
      );
      if (proceed != true || !mounted) return;
    }

    setState(() => _saving = true);
    try {
      await repo.createOrder(
        customerId: widget.customer.id,
        lines: _cart.values.toList(),
        visitId: widget.visitId,
        note: _note.text.trim().isEmpty ? null : _note.text.trim(),
      );

      if (!mounted) return;
      Navigator.pop(context);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            'Order saved — ${Money.format(_total)}. It will sync automatically.',
          ),
          behavior: SnackBarBehavior.floating,
        ),
      );
    } catch (error) {
      if (mounted) {
        setState(() => _saving = false);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('$error'), backgroundColor: RautTheme.danger),
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('New order'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(64),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: TextField(
              controller: _search,
              onChanged: (_) => _loadProducts(),
              decoration: InputDecoration(
                hintText: 'Search products…',
                prefixIcon: const Icon(Icons.search),
                isDense: true,
                suffixIcon: _search.text.isEmpty
                    ? null
                    : IconButton(
                        icon: const Icon(Icons.clear),
                        onPressed: () {
                          _search.clear();
                          _loadProducts();
                        },
                      ),
              ),
            ),
          ),
        ),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Column(
              children: [
                Container(
                  width: double.infinity,
                  color: Colors.grey.shade100,
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                  child: Text(
                    widget.customer.name,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                Expanded(
                  child: _products.isEmpty
                      ? Center(
                          child: Text(
                            'No products on this device yet.\nSync to download the catalogue.',
                            textAlign: TextAlign.center,
                            style: TextStyle(color: Colors.grey.shade600),
                          ),
                        )
                      : ListView.separated(
                          itemCount: _products.length,
                          separatorBuilder: (_, __) => const Divider(height: 1),
                          itemBuilder: (context, index) {
                            final product = _products[index];
                            final variant = _selected(product);
                            final line = _cart[_key(product, variant)];
                            return _ProductRow(
                              product: product,
                              variants: _variants[product.id] ?? const [],
                              selected: variant,
                              quantity: line?.quantity ?? 0,
                              onVariantChanged: (v) => setState(() {
                                if (v == null) {
                                  _chosenVariant.remove(product.id);
                                } else {
                                  _chosenVariant[product.id] = v.id;
                                }
                              }),
                              onChanged: (q) => _setQuantity(product, variant, q),
                            );
                          },
                        ),
                ),
              ],
            ),

      bottomNavigationBar: _cart.isEmpty
          ? null
          : SafeArea(
              child: Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border(top: BorderSide(color: Colors.grey.shade300)),
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    TextField(
                      controller: _note,
                      decoration: const InputDecoration(
                        labelText: 'Note (optional)',
                        isDense: true,
                      ),
                    ),
                    const SizedBox(height: 12),
                    _TotalRow('Subtotal', _subtotal),
                    _TotalRow('VAT', _tax),
                    const Divider(height: 16),
                    _TotalRow('Total', _total, emphasis: true),
                    const SizedBox(height: 12),
                    FilledButton.icon(
                      onPressed: _saving ? null : _save,
                      icon: _saving
                          ? const SizedBox(
                              height: 18,
                              width: 18,
                              child: CircularProgressIndicator(
                                strokeWidth: 2,
                                color: Colors.white,
                              ),
                            )
                          : const Icon(Icons.check),
                      label: Text(
                        _saving
                            ? 'Saving…'
                            : 'Save order · ${_cart.length} line(s)',
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}

class _ProductRow extends StatelessWidget {
  const _ProductRow({
    required this.product,
    required this.variants,
    required this.selected,
    required this.quantity,
    required this.onChanged,
    required this.onVariantChanged,
  });

  final Product product;
  final List<ProductVariant> variants;
  final ProductVariant? selected;
  final int quantity;
  final ValueChanged<int> onChanged;
  final ValueChanged<ProductVariant?> onVariantChanged;

  @override
  Widget build(BuildContext context) {
    final van = product.vanQuantity;
    final perUnit = selected?.unitsPerVariant ?? 1;
    // Compared in base units. Two cartons of twelve against a van holding
    // twenty is short, and comparing 2 against 20 would say it was fine.
    final short = van != null && quantity * perUnit > van;
    final price = selected?.sellPriceCents ?? product.sellPriceCents;
    final unitLabel = selected?.name ?? product.unit;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  product.name,
                  style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                ),
                const SizedBox(height: 2),
                Row(
                  children: [
                    Text(
                      '${Money.format(price)} / $unitLabel',
                      style: TextStyle(fontSize: 12.5, color: Colors.grey.shade600),
                    ),
                    if (van != null) ...[
                      Text(
                        '  ·  ',
                        style: TextStyle(color: Colors.grey.shade400),
                      ),
                      Text(
                        'van: $van',
                        style: TextStyle(
                          fontSize: 12.5,
                          color: short ? RautTheme.warning : Colors.grey.shade600,
                          fontWeight: short ? FontWeight.w700 : FontWeight.normal,
                        ),
                      ),
                    ],
                  ],
                ),
                if (short)
                  Text(
                    'More than you are carrying — it will still be ordered',
                    style: TextStyle(fontSize: 11, color: RautTheme.warning),
                  ),

                // Only where there is a choice to make. A product sold one way
                // does not need a selector that has one option in it.
                if (variants.length > 1) ...[
                  const SizedBox(height: 6),
                  SizedBox(
                    height: 32,
                    child: ListView.separated(
                      scrollDirection: Axis.horizontal,
                      itemCount: variants.length,
                      separatorBuilder: (_, __) => const SizedBox(width: 6),
                      itemBuilder: (context, i) {
                        final v = variants[i];
                        final on = v.id == selected?.id;
                        return ChoiceChip(
                          label: Text(
                            v.unitsPerVariant == 1
                                ? v.name
                                : '${v.name} (${v.unitsPerVariant})',
                            style: const TextStyle(fontSize: 11.5),
                          ),
                          selected: on,
                          visualDensity: VisualDensity.compact,
                          onSelected: (_) => onVariantChanged(v),
                        );
                      },
                    ),
                  ),
                  if (selected != null && selected!.unitsPerVariant > 1)
                    Padding(
                      padding: const EdgeInsets.only(top: 2),
                      child: Text(
                        // The number a shopkeeper actually wants: what one
                        // bottle costs if they take the whole dozen.
                        '${Money.format(selected!.perBaseUnitCents)} per ${product.unit}',
                        style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                      ),
                    ),
                ],
              ],
            ),
          ),
          _Stepper(quantity: quantity, onChanged: onChanged),
        ],
      ),
    );
  }
}

class _Stepper extends StatelessWidget {
  const _Stepper({required this.quantity, required this.onChanged});

  final int quantity;
  final ValueChanged<int> onChanged;

  @override
  Widget build(BuildContext context) {
    if (quantity == 0) {
      return IconButton.filledTonal(
        onPressed: () => onChanged(1),
        icon: const Icon(Icons.add),
        tooltip: 'Add',
      );
    }

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        IconButton(
          onPressed: () => onChanged(quantity - 1),
          icon: const Icon(Icons.remove_circle_outline),
          visualDensity: VisualDensity.compact,
        ),
        SizedBox(
          width: 34,
          child: Text(
            '$quantity',
            textAlign: TextAlign.center,
            style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16),
          ),
        ),
        IconButton(
          onPressed: () => onChanged(quantity + 1),
          icon: const Icon(Icons.add_circle_outline),
          visualDensity: VisualDensity.compact,
        ),
      ],
    );
  }
}

class _TotalRow extends StatelessWidget {
  const _TotalRow(this.label, this.cents, {this.emphasis = false});

  final String label;
  final int cents;
  final bool emphasis;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          Text(
            label,
            style: TextStyle(
              fontSize: emphasis ? 15 : 13,
              fontWeight: emphasis ? FontWeight.w700 : FontWeight.normal,
              color: emphasis ? null : Colors.grey.shade700,
            ),
          ),
          const Spacer(),
          Text(
            Money.format(cents, decimals: true),
            style: TextStyle(
              fontSize: emphasis ? 17 : 13,
              fontWeight: FontWeight.w700,
              color: emphasis ? RautTheme.brand : null,
            ),
          ),
        ],
      ),
    );
  }
}

