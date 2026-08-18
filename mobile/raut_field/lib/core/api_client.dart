import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'config.dart';

/// Thrown for any non-2xx response. Carries the server's error code so callers
/// can distinguish "you are offline" from "your subscription lacks this module".
class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message, [this.details]);

  final int statusCode;
  final String code;
  final String message;
  final Object? details;

  /// A module the company has not bought (HTTP 402). Not an error to retry.
  bool get isModuleLocked => statusCode == 402;

  /// Credentials are stale — the caller should refresh or sign in again.
  bool get isUnauthenticated => statusCode == 401;

  @override
  String toString() => message;
}

/// Thrown when the request never reached the server. Distinct from
/// ApiException on purpose: offline work is queued and retried, whereas a
/// server rejection usually means the operation is invalid and retrying it
/// forever would wedge the outbox.
class NetworkException implements Exception {
  NetworkException(this.message);
  final String message;

  @override
  String toString() => message;
}

/// Thin HTTP client over /api/v1.
///
/// Handles one thing beyond plain requests: a single automatic refresh-and-
/// retry when an access token has expired. Without it, a rep who left the app
/// backgrounded for an hour gets a spurious "session expired" on their first
/// tap of the morning.
class ApiClient {
  ApiClient({http.Client? client}) : _http = client ?? http.Client();

  final http.Client _http;

  String? _accessToken;
  String? _refreshToken;

  /// Called when refresh succeeds, so credentials can be persisted.
  void Function(String accessToken, String refreshToken)? onTokensRefreshed;

  /// Called when refresh fails and the session is unrecoverable.
  void Function()? onSessionExpired;

  void setTokens({String? accessToken, String? refreshToken}) {
    _accessToken = accessToken;
    _refreshToken = refreshToken;
  }

  void clearTokens() {
    _accessToken = null;
    _refreshToken = null;
  }

  bool get hasSession => _accessToken != null;

  static const Duration _timeout = Duration(seconds: 25);

  Future<Map<String, dynamic>> get(
    String path, {
    Map<String, String>? query,
  }) =>
      _send('GET', path, query: query);

  Future<Map<String, dynamic>> post(String path, Object? body) =>
      _send('POST', path, body: body);

  Future<Map<String, dynamic>> patch(String path, Object? body) =>
      _send('PATCH', path, body: body);

  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Object? body,
    Map<String, String>? query,
    bool isRetry = false,
  }) async {
    final uri = Uri.parse('${AppConfig.apiV1}$path').replace(
      queryParameters: query?.isEmpty ?? true ? null : query,
    );

    final request = http.Request(method, uri)
      ..headers['Content-Type'] = 'application/json'
      ..headers['Accept'] = 'application/json';

    if (_accessToken != null) {
      request.headers['Authorization'] = 'Bearer $_accessToken';
    }
    if (body != null) request.body = jsonEncode(body);

    http.Response response;
    try {
      final streamed = await _http.send(request).timeout(_timeout);
      response = await http.Response.fromStream(streamed);
    } on TimeoutException {
      throw NetworkException('The server took too long to respond');
    } catch (error) {
      throw NetworkException('No connection to the Raut server');
    }

    Map<String, dynamic> json;
    try {
      json = jsonDecode(response.body) as Map<String, dynamic>;
    } catch (_) {
      throw ApiException(
        response.statusCode,
        'BAD_RESPONSE',
        'The server returned an unreadable response',
      );
    }

    if (json['ok'] == true) {
      return json['data'] is Map<String, dynamic>
          ? json['data'] as Map<String, dynamic>
          : <String, dynamic>{'value': json['data'], 'meta': json['meta']};
    }

    final error = (json['error'] as Map<String, dynamic>?) ?? const {};
    final code = (error['code'] ?? 'UNKNOWN').toString();

    // One refresh attempt, then give up. Retrying a refresh loop would hammer
    // the server with a credential that is already known bad.
    if (response.statusCode == 401 && !isRetry && _refreshToken != null) {
      final refreshed = await _refresh();
      if (refreshed) {
        return _send(method, path, body: body, query: query, isRetry: true);
      }
      onSessionExpired?.call();
    }

    throw ApiException(
      response.statusCode,
      code,
      (error['message'] ?? 'Request failed').toString(),
      error['details'],
    );
  }

  Future<bool> _refresh() async {
    final token = _refreshToken;
    if (token == null) return false;

    try {
      final response = await _http
          .post(
            Uri.parse('${AppConfig.apiV1}/auth/refresh'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({'refreshToken': token}),
          )
          .timeout(_timeout);

      if (response.statusCode != 200) return false;

      final json = jsonDecode(response.body) as Map<String, dynamic>;
      if (json['ok'] != true) return false;

      final data = json['data'] as Map<String, dynamic>;
      _accessToken = data['accessToken'] as String?;
      _refreshToken = data['refreshToken'] as String?;

      if (_accessToken != null && _refreshToken != null) {
        onTokensRefreshed?.call(_accessToken!, _refreshToken!);
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  /// Raw login — no bearer token is attached, and failures surface verbatim.
  Future<Map<String, dynamic>> login({
    required String email,
    required String password,
    required Map<String, dynamic> device,
  }) async {
    final response = await _send('POST', '/auth/login', body: {
      'email': email,
      'password': password,
      'device': device,
    });
    _accessToken = response['accessToken'] as String?;
    _refreshToken = response['refreshToken'] as String?;
    return response;
  }

  void dispose() => _http.close();
}
