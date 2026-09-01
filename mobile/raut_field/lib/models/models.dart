// Local-store models.
//
// Deliberately plain: these mirror sqflite rows, so every field is nullable-
// tolerant and parsing never throws on a column the server has not sent yet.
// A model that crashes on an unexpected null would take the whole app down in
// the field, where the rep cannot do anything about it.

int _int(Object? v, [int fallback = 0]) =>
    v is int ? v : (v is num ? v.toInt() : (v is String ? int.tryParse(v) ?? fallback : fallback));

double? _double(Object? v) =>
    v is double ? v : (v is num ? v.toDouble() : (v is String ? double.tryParse(v) : null));

String _str(Object? v, [String fallback = '']) => v?.toString() ?? fallback;

DateTime? _date(Object? v) =>
    v == null ? null : DateTime.tryParse(v.toString())?.toLocal();

bool _bool(Object? v) => v == 1 || v == true || v == '1';

class Customer {
  Customer({
    required this.id,
    required this.name,
    this.code = '',
    this.type = 'RETAIL',
    this.segment = 'C',
    this.phone,
    this.email,
    this.address,
    this.town,
    this.latitude,
    this.longitude,
    this.geofenceRadiusM = 150,
    this.creditLimitCents = 0,
    this.paymentTermsDays = 0,
    this.balanceCents = 0,
    this.status = 'ACTIVE',
    this.territoryId,
    this.notes,
    this.pendingUuid,
  });

  final String id;
  final String name;
  final String code;
  final String type;
  final String segment;
  final String? phone;
  final String? email;
  final String? address;
  final String? town;
  final double? latitude;
  final double? longitude;
  final int geofenceRadiusM;
  final int creditLimitCents;
  final int paymentTermsDays;
  final int balanceCents;
  final String status;
  final String? territoryId;
  final String? notes;

  /// Set while this customer exists only on the handset.
  final String? pendingUuid;

  bool get hasPin => latitude != null && longitude != null;
  bool get isPending => pendingUuid != null;
  bool get owesMoney => balanceCents > 0;
  bool get overCreditLimit => creditLimitCents > 0 && balanceCents > creditLimitCents;

  factory Customer.fromRow(Map<String, Object?> r) => Customer(
        id: _str(r['id']),
        name: _str(r['name']),
        code: _str(r['code']),
        type: _str(r['type'], 'RETAIL'),
        segment: _str(r['segment'], 'C'),
        phone: r['phone'] as String?,
        email: r['email'] as String?,
        address: r['address'] as String?,
        town: r['town'] as String?,
        latitude: _double(r['latitude']),
        longitude: _double(r['longitude']),
        geofenceRadiusM: _int(r['geofenceRadiusM'], 150),
        creditLimitCents: _int(r['creditLimitCents']),
        paymentTermsDays: _int(r['paymentTermsDays']),
        balanceCents: _int(r['balanceCents']),
        status: _str(r['status'], 'ACTIVE'),
        territoryId: r['territoryId'] as String?,
        notes: r['notes'] as String?,
        pendingUuid: r['pendingUuid'] as String?,
      );
}

class Product {
  Product({
    required this.id,
    required this.name,
    this.sku = '',
    this.unit = 'PC',
    this.sellPriceCents = 0,
    this.taxRateBp = 1600,
    this.active = true,
    this.vanQuantity,
  });

  final String id;
  final String name;
  final String sku;
  final String unit;
  final int sellPriceCents;
  final int taxRateBp;
  final bool active;

  /// Stock on the rep's van, when the Inventory module is licensed.
  final int? vanQuantity;

  factory Product.fromRow(Map<String, Object?> r) => Product(
        id: _str(r['id']),
        name: _str(r['name']),
        sku: _str(r['sku']),
        unit: _str(r['unit'], 'PC'),
        sellPriceCents: _int(r['sellPriceCents']),
        taxRateBp: _int(r['taxRateBp'], 1600),
        active: _bool(r['active']),
        vanQuantity: r['vanQuantity'] == null ? null : _int(r['vanQuantity']),
      );
}

class Visit {
  Visit({
    required this.id,
    required this.customerId,
    required this.status,
    required this.scheduledAt,
    this.routeId,
    this.purpose = 'SALES',
    this.checkInAt,
    this.checkInLat,
    this.checkInLng,
    this.checkOutAt,
    this.geofenceVerified = false,
    this.distanceFromCustomerM,
    this.durationMin,
    this.outcome,
    this.notes,
    this.dirty = false,
  });

  final String id;
  final String customerId;
  final String status;
  final DateTime scheduledAt;
  final String? routeId;
  final String purpose;
  final DateTime? checkInAt;
  final double? checkInLat;
  final double? checkInLng;
  final DateTime? checkOutAt;
  final bool geofenceVerified;
  final int? distanceFromCustomerM;
  final int? durationMin;
  final String? outcome;
  final String? notes;

  /// A check-in or check-out is queued but the server has not confirmed it.
  final bool dirty;

  bool get isCheckedIn => checkInAt != null && checkOutAt == null;
  bool get isDone => status == 'COMPLETED';
  bool get canCheckIn => checkInAt == null && status != 'CANCELLED';
  bool get canCheckOut => isCheckedIn;

  factory Visit.fromRow(Map<String, Object?> r) => Visit(
        id: _str(r['id']),
        customerId: _str(r['customerId']),
        status: _str(r['status'], 'SCHEDULED'),
        scheduledAt: _date(r['scheduledAt']) ?? DateTime.now(),
        routeId: r['routeId'] as String?,
        purpose: _str(r['purpose'], 'SALES'),
        checkInAt: _date(r['checkInAt']),
        checkInLat: _double(r['checkInLat']),
        checkInLng: _double(r['checkInLng']),
        checkOutAt: _date(r['checkOutAt']),
        geofenceVerified: _bool(r['geofenceVerified']),
        distanceFromCustomerM:
            r['distanceFromCustomerM'] == null ? null : _int(r['distanceFromCustomerM']),
        durationMin: r['durationMin'] == null ? null : _int(r['durationMin']),
        outcome: r['outcome'] as String?,
        notes: r['notes'] as String?,
        dirty: _bool(r['dirty']),
      );
}

class RouteStop {
  RouteStop({
    required this.id,
    required this.routeId,
    required this.customerId,
    required this.sequence,
    this.status = 'PENDING',
    this.plannedAt,
    this.legDistanceM = 0,
    this.legMin = 0,
  });

  final String id;
  final String routeId;
  final String customerId;
  final int sequence;
  final String status;
  final DateTime? plannedAt;
  final int legDistanceM;
  final int legMin;

  factory RouteStop.fromRow(Map<String, Object?> r) => RouteStop(
        id: _str(r['id']),
        routeId: _str(r['routeId']),
        customerId: _str(r['customerId']),
        sequence: _int(r['sequence']),
        status: _str(r['status'], 'PENDING'),
        plannedAt: _date(r['plannedAt']),
        legDistanceM: _int(r['legDistanceM']),
        legMin: _int(r['legMin']),
      );
}

class FieldRoute {
  FieldRoute({
    required this.id,
    required this.name,
    required this.routeDate,
    this.status = 'PLANNED',
    this.totalDistanceM = 0,
    this.estimatedMin = 0,
    this.territoryId,
    this.stops = const [],
  });

  final String id;
  final String name;
  final DateTime routeDate;
  final String status;
  final int totalDistanceM;
  final int estimatedMin;
  final String? territoryId;
  final List<RouteStop> stops;

  double get distanceKm => totalDistanceM / 1000;

  factory FieldRoute.fromRow(Map<String, Object?> r, List<RouteStop> stops) =>
      FieldRoute(
        id: _str(r['id']),
        name: _str(r['name'], 'Route'),
        routeDate: _date(r['routeDate']) ?? DateTime.now(),
        status: _str(r['status'], 'PLANNED'),
        totalDistanceM: _int(r['totalDistanceM']),
        estimatedMin: _int(r['estimatedMin']),
        territoryId: r['territoryId'] as String?,
        stops: stops,
      );
}

class InvoiceSummary {
  InvoiceSummary({
    required this.id,
    required this.number,
    required this.customerId,
    required this.status,
    required this.totalCents,
    required this.paidCents,
    this.subtotalCents = 0,
    this.discountCents = 0,
    this.taxCents = 0,
    this.dueDate,
    this.issueDate,
    this.etimsStatus,
    this.etimsControlCode,
    this.etimsInvoiceNumber,
    this.etimsSerialNumber,
    this.etimsQrUrl,
  });

  final String id;
  final String number;
  final String customerId;
  final String status;
  final int subtotalCents;
  final int discountCents;
  final int taxCents;
  final int totalCents;
  final int paidCents;
  final DateTime? dueDate;
  final DateTime? issueDate;

  /// NOT_APPLICABLE | QUEUED | SUBMITTED | ACCEPTED | REJECTED
  final String? etimsStatus;
  final String? etimsControlCode;
  final String? etimsInvoiceNumber;
  final String? etimsSerialNumber;
  final String? etimsQrUrl;

  int get outstandingCents => totalCents - paidCents;
  bool get isOverdue => status == 'OVERDUE';

  /// Only a document KRA has accepted is a tax invoice. The control code is
  /// checked as well as the status because one without the other is a state
  /// that should not exist, and printing it as valid would be worse than
  /// admitting we do not have it.
  bool get isFiled =>
      etimsStatus == 'ACCEPTED' && (etimsControlCode?.isNotEmpty ?? false);

  /// Waiting on KRA, or refused by it. Either way the rep owes a reprint.
  bool get needsFiling =>
      etimsStatus == 'QUEUED' ||
      etimsStatus == 'REJECTED' ||
      etimsStatus == 'SUBMITTED';

  factory InvoiceSummary.fromRow(Map<String, Object?> r) => InvoiceSummary(
        id: _str(r['id']),
        number: _str(r['number']),
        customerId: _str(r['customerId']),
        status: _str(r['status']),
        subtotalCents: _int(r['subtotalCents']),
        discountCents: _int(r['discountCents']),
        taxCents: _int(r['taxCents']),
        totalCents: _int(r['totalCents']),
        paidCents: _int(r['paidCents']),
        dueDate: _date(r['dueDate']),
        issueDate: _date(r['issueDate']),
        etimsStatus: r['etimsStatus'] as String?,
        etimsControlCode: r['etimsControlCode'] as String?,
        etimsInvoiceNumber: r['etimsInvoiceNumber'] as String?,
        etimsSerialNumber: r['etimsSerialNumber'] as String?,
        etimsQrUrl: r['etimsQrUrl'] as String?,
      );
}

/// One line on an invoice, mirrored so a receipt can be reprinted offline.
class InvoiceLine {
  InvoiceLine({
    required this.id,
    required this.invoiceId,
    required this.productId,
    required this.description,
    required this.quantity,
    required this.unitPriceCents,
    required this.lineTotalCents,
    this.discountCents = 0,
    this.taxRateBp = 1600,
    this.variantName,
    this.baseQuantity = 0,
  });

  final String id;
  final String invoiceId;
  final String productId;
  final String description;
  final int quantity;
  final int unitPriceCents;
  final int discountCents;
  final int taxRateBp;
  final int lineTotalCents;

  /// The selling unit as it was at the time of sale, snapshotted server-side.
  final String? variantName;

  /// The line in base units. Zero on lines written before variants existed.
  final int baseQuantity;

  factory InvoiceLine.fromRow(Map<String, Object?> r) => InvoiceLine(
        id: _str(r['id']),
        invoiceId: _str(r['invoiceId']),
        productId: _str(r['productId']),
        description: _str(r['description']),
        quantity: _int(r['quantity']),
        unitPriceCents: _int(r['unitPriceCents']),
        discountCents: _int(r['discountCents']),
        taxRateBp: _int(r['taxRateBp']),
        lineTotalCents: _int(r['lineTotalCents']),
        variantName: r['variantName'] as String?,
        baseQuantity: _int(r['baseQuantity']),
      );
}

/// A way of selling a product.
///
/// One product, one stock pool held in base units, and several selling units
/// on top of it. Two cartons of twelve take twenty-four units off the shelf —
/// which is the whole of stock splitting, and why nothing has to be converted.
class ProductVariant {
  const ProductVariant({
    required this.id,
    required this.productId,
    required this.name,
    required this.sku,
    required this.unitsPerVariant,
    required this.sellPriceCents,
    this.barcode,
    this.isDefault = false,
  });

  final String id;
  final String productId;
  final String name;
  final String sku;
  final String? barcode;
  final int unitsPerVariant;
  final int sellPriceCents;
  final bool isDefault;

  /// What one base unit works out at when bought this way. Shown so a rep can
  /// answer "is the carton actually cheaper" without doing it in their head.
  int get perBaseUnitCents =>
      unitsPerVariant > 0 ? (sellPriceCents / unitsPerVariant).round() : sellPriceCents;

  factory ProductVariant.fromRow(Map<String, Object?> r) => ProductVariant(
        id: _str(r['id']),
        productId: _str(r['productId']),
        name: _str(r['name']),
        sku: _str(r['sku']),
        barcode: r['barcode'] as String?,
        unitsPerVariant: _int(r['unitsPerVariant']) == 0 ? 1 : _int(r['unitsPerVariant']),
        sellPriceCents: _int(r['sellPriceCents']),
        isDefault: _int(r['isDefault']) == 1,
      );
}

/// The seller's details, for the top of a receipt.
///
/// Comes from the login response rather than being configured on the handset:
/// a PIN typed into a device by a rep is a PIN that will eventually be typed
/// in wrong, and it is the one field on the receipt that must be right.
class CompanyInfo {
  const CompanyInfo({
    required this.id,
    required this.name,
    this.taxPin,
    this.address,
    this.phone,
    this.email,
  });

  final String id;
  final String name;
  final String? taxPin;
  final String? address;
  final String? phone;
  final String? email;

  factory CompanyInfo.fromJson(Map<String, dynamic> j) => CompanyInfo(
        id: j['id'] as String? ?? '',
        name: j['name'] as String? ?? '',
        taxPin: j['taxPin'] as String?,
        address: j['address'] as String?,
        phone: j['phone'] as String?,
        email: j['email'] as String?,
      );

  Map<String, Object?> toJson() => {
        'id': id,
        'name': name,
        'taxPin': taxPin,
        'address': address,
        'phone': phone,
        'email': email,
      };
}

/// A line being built on the order screen, before it becomes an outbox payload.
///
/// `quantity` counts the unit being sold — two cartons is two, not twenty-four.
/// The server multiplies by the variant to move stock, and doing that
/// arithmetic here as well would give two places for it to disagree.
class CartLine {
  CartLine({
    required this.product,
    required this.quantity,
    this.variant,
    this.discountCents = 0,
  });

  final Product product;

  /// The selling unit. Null means the product's base unit, which is what the
  /// screen used before variants existed.
  final ProductVariant? variant;

  int quantity;
  int discountCents;

  /// Price of one of whatever is being sold.
  int get unitPriceCents => variant?.sellPriceCents ?? product.sellPriceCents;

  /// What comes off the shelf. The server recomputes this rather than trusting
  /// it; it is here so the van-stock warning is honest at the point of sale.
  int get baseQuantity => quantity * (variant?.unitsPerVariant ?? 1);

  String get label => variant == null ? product.name : '${product.name} - ${variant!.name}';

  int get grossCents => quantity * unitPriceCents;
  int get netCents => grossCents - discountCents;
  int get taxCents => (netCents * product.taxRateBp / 10000).round();
  int get totalCents => netCents + taxCents;

  Map<String, dynamic> toPayload() => {
        'productId': product.id,
        if (variant != null) 'variantId': variant!.id,
        'quantity': quantity,
        'unitPriceCents': unitPriceCents,
        if (discountCents > 0) 'discountCents': discountCents,
        'description': label,
      };
}
