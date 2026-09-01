import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/models.dart';
import 'api_client.dart';
import 'config.dart';
import 'local_db.dart';

class Session {
  const Session({
    required this.userId,
    required this.name,
    required this.email,
    required this.role,
    required this.companyId,
    required this.companyName,
    required this.modules,
    required this.permissions,
    this.branchId,
    this.branchName,
    this.phone,
    this.company,
    this.etimsEnabled = false,
    this.etimsEnvironment = 'SANDBOX',
  });

  final String userId;
  final String name;
  final String email;
  final String role;
  final String companyId;
  final String companyName;
  final List<String> modules;
  final List<String> permissions;
  final String? branchId;
  final String? branchName;
  final String? phone;

  /// The seller's details for a printed receipt. Null on an older session
  /// restored from storage, which is why every use is null-guarded.
  final CompanyInfo? company;

  /// Whether this company files with KRA. Decides what the POS does at the
  /// moment of sale — wait for a control code, or print straight away. The app
  /// must not infer it from the module licence: a company can hold the licence
  /// and still have transmission switched off.
  final bool etimsEnabled;
  final String etimsEnvironment;

  bool hasModule(String key) => modules.contains(key);
  bool can(String permission) => permissions.contains(permission);

  /// Whether visit check-ins are verified against the customer geofence.
  /// Module 08 is sold separately, so the app must not promise verification
  /// the company has not bought.
  bool get geofencingEnabled => hasModule('GEOFENCING');
  bool get routingEnabled => hasModule('ROUTING');
  bool get canTakePayments => hasModule('SALES_POS') && can('payment:write');
  bool get canRaiseExpenses => hasModule('FINANCE') && can('expense:write');

  String get firstName => name.split(' ').first;

  /// A receipt can only be printed where there is a company header to print.
  bool get canPrintReceipts => company != null;

  /// Reps push their own stuck filings; they cannot read the company log.
  bool get canRetryEtims => etimsEnabled && can('etims:submit');

  Map<String, dynamic> toJson() => {
        'userId': userId,
        'name': name,
        'email': email,
        'role': role,
        'companyId': companyId,
        'companyName': companyName,
        'modules': modules,
        'permissions': permissions,
        'branchId': branchId,
        'branchName': branchName,
        'phone': phone,
        'company': company?.toJson(),
        'etimsEnabled': etimsEnabled,
        'etimsEnvironment': etimsEnvironment,
      };

  factory Session.fromJson(Map<String, dynamic> json) => Session(
        userId: json['userId'] as String,
        name: json['name'] as String,
        email: json['email'] as String,
        role: json['role'] as String,
        companyId: json['companyId'] as String,
        companyName: json['companyName'] as String,
        modules: (json['modules'] as List).cast<String>(),
        permissions: (json['permissions'] as List).cast<String>(),
        branchId: json['branchId'] as String?,
        branchName: json['branchName'] as String?,
        phone: json['phone'] as String?,
        company: json['company'] == null
            ? null
            : CompanyInfo.fromJson(json['company'] as Map<String, dynamic>),
        etimsEnabled: json['etimsEnabled'] as bool? ?? false,
        etimsEnvironment: json['etimsEnvironment'] as String? ?? 'SANDBOX',
      );
}

/// Authentication and session persistence.
///
/// Tokens live in SharedPreferences. That is adequate for this build and no
/// more: on a rooted or compromised handset they are readable. The mitigation
/// that matters operationally is server-side — access tokens are short-lived
/// and refresh tokens are bound to a device row an admin can revoke. Moving to
/// the platform keystore is a worthwhile hardening step and is called out in
/// the docs rather than silently assumed.
class AuthService extends ChangeNotifier {
  AuthService({required ApiClient api, required LocalDb db})
      : _api = api,
        _db = db {
    _api.onTokensRefreshed = _persistTokens;
    _api.onSessionExpired = () {
      // Do not wipe local data here: the rep may have unsynced work, and
      // destroying it because a token lapsed would be the worst possible
      // failure mode. Just drop the session and let them sign in again.
      _session = null;
      notifyListeners();
    };
  }

  final ApiClient _api;
  final LocalDb _db;

  static const _sessionKey = 'raut.session';
  static const _accessKey = 'raut.accessToken';
  static const _refreshKey = 'raut.refreshToken';
  static const _deviceIdKey = 'raut.deviceId';

  Session? _session;
  Session? get session => _session;
  bool get isSignedIn => _session != null;

  bool _restoring = true;
  bool get isRestoring => _restoring;

  String? _error;
  String? get error => _error;

  bool _busy = false;
  bool get isBusy => _busy;

  /// Restores a previous session so a rep who lost signal overnight opens
  /// straight into their route rather than a login form they cannot complete.
  Future<void> restore() async {
    final prefs = await SharedPreferences.getInstance();

    final raw = prefs.getString(_sessionKey);
    final access = prefs.getString(_accessKey);
    final refresh = prefs.getString(_refreshKey);

    if (raw != null && access != null) {
      try {
        _session = Session.fromJson(jsonDecode(raw) as Map<String, dynamic>);
        _api.setTokens(accessToken: access, refreshToken: refresh);
      } catch (_) {
        _session = null;
      }
    }

    _restoring = false;
    notifyListeners();

    // Refresh licences in the background. A module revoked overnight should
    // take effect without blocking the rep from opening the app.
    if (_session != null) unawaited(_refreshProfile());
  }

  @visibleForTesting
  Future<void> refreshProfile() => _refreshProfile();

  Future<bool> signIn(String email, String password) async {
    _busy = true;
    _error = null;
    notifyListeners();

    try {
      final device = await _deviceInfo();
      final data = await _api.login(
        email: email.trim().toLowerCase(),
        password: password,
        device: device,
      );

      final user = data['user'] as Map<String, dynamic>;
      final company = data['company'] as Map<String, dynamic>?;

      if (company == null) {
        _error = 'This account is not attached to a company.';
        return false;
      }
      if (user['role'] != 'FIELD_REP' &&
          !(data['modules'] as List).contains('FIELD_SALES')) {
        _error = 'Field Sales is not part of your subscription.';
        return false;
      }

      _session = Session(
        userId: user['id'] as String,
        name: user['name'] as String,
        email: user['email'] as String,
        role: user['role'] as String,
        phone: user['phone'] as String?,
        branchId: user['branchId'] as String?,
        branchName: user['branchName'] as String?,
        companyId: company['id'] as String,
        companyName: company['name'] as String,
        modules: (data['modules'] as List).cast<String>(),
        permissions: (data['permissions'] as List? ?? const []).cast<String>(),
        company: CompanyInfo.fromJson(company),
        etimsEnabled:
            (data['etims'] as Map<String, dynamic>?)?['enabled'] as bool? ?? false,
        etimsEnvironment:
            (data['etims'] as Map<String, dynamic>?)?['environment'] as String? ??
                'SANDBOX',
      );

      await _persistSession(
        data['accessToken'] as String,
        data['refreshToken'] as String?,
      );
      return true;
    } on ApiException catch (error) {
      _error = error.message;
      return false;
    } on NetworkException catch (error) {
      _error = '${error.message}. Check the server address in settings.';
      return false;
    } finally {
      _busy = false;
      notifyListeners();
    }
  }

  /// Re-reads licences and permissions from the server.
  Future<void> _refreshProfile() async {
    try {
      final data = await _api.get('/auth/me');
      final user = data['user'] as Map<String, dynamic>;
      final company = data['company'] as Map<String, dynamic>?;
      if (company == null) return;

      _session = Session(
        userId: user['id'] as String,
        name: user['name'] as String,
        email: user['email'] as String,
        role: user['role'] as String,
        phone: user['phone'] as String?,
        branchId: user['branchId'] as String?,
        branchName: user['branchName'] as String?,
        companyId: company['id'] as String,
        companyName: company['name'] as String,
        modules: (data['modules'] as List).cast<String>(),
        permissions: (data['permissions'] as List? ?? const []).cast<String>(),
        company: CompanyInfo.fromJson(company),
        etimsEnabled:
            (data['etims'] as Map<String, dynamic>?)?['enabled'] as bool? ?? false,
        etimsEnvironment:
            (data['etims'] as Map<String, dynamic>?)?['environment'] as String? ??
                'SANDBOX',
      );

      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_sessionKey, jsonEncode(_session!.toJson()));
      notifyListeners();
    } catch (_) {
      // Offline or transient — the cached session stays valid.
    }
  }

  Future<void> _persistSession(String access, String? refresh) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_sessionKey, jsonEncode(_session!.toJson()));
    await prefs.setString(_accessKey, access);
    if (refresh != null) await prefs.setString(_refreshKey, refresh);
  }

  Future<void> _persistTokens(String access, String refresh) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_accessKey, access);
    await prefs.setString(_refreshKey, refresh);
  }

  /// Signs out. Refuses while work is unsynced unless forced, because wiping
  /// the local store would destroy orders the business has not yet received.
  Future<bool> signOut({bool force = false}) async {
    final pending = await _db.count('outbox', where: 'syncedAt IS NULL');
    if (pending > 0 && !force) return false;

    final prefs = await SharedPreferences.getInstance();
    final refresh = prefs.getString(_refreshKey);

    try {
      await _api.post('/auth/logout', {'refreshToken': refresh});
    } catch (_) {
      // Signing out locally must work even with no connection.
    }

    _api.clearTokens();
    await prefs.remove(_sessionKey);
    await prefs.remove(_accessKey);
    await prefs.remove(_refreshKey);
    await _db.wipe();

    _session = null;
    notifyListeners();
    return true;
  }

  Future<Map<String, dynamic>> _deviceInfo() async {
    final prefs = await SharedPreferences.getInstance();
    var deviceId = prefs.getString(_deviceIdKey);
    if (deviceId == null) {
      deviceId = 'raut-${DateTime.now().millisecondsSinceEpoch}-'
          '${DateTime.now().microsecond}';
      await prefs.setString(_deviceIdKey, deviceId);
    }

    return {
      'deviceId': deviceId,
      'platform': Platform.operatingSystem,
      'model': Platform.operatingSystemVersion,
      'appVersion': AppConfig.appVersion,
    };
  }
}
