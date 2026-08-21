import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../core/auth_service.dart';
import '../core/config.dart';
import '../theme.dart';
import '../widgets/raut_mark.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController(text: 'rep@zamarsolutions.co.ke');
  final _password = TextEditingController();
  bool _obscure = true;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    FocusScope.of(context).unfocus();
    await context.read<AuthService>().signIn(_email.text, _password.text);
  }

  @override
  Widget build(BuildContext context) {
    final auth = context.watch<AuthService>();

    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Form(
            key: _formKey,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SizedBox(height: 24),
                // The supplied lockup carries the wordmark and strapline, so
                // it stands alone rather than being repeated in text.
                const Align(
                  alignment: Alignment.centerLeft,
                  child: RautLockup(size: 150),
                ),
                const SizedBox(height: 20),
                const Text(
                  'Field Sales',
                  style: TextStyle(fontSize: 26, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 6),
                Text(
                  'Sign in to load your route. You can work offline once your '
                  'data has synced.',
                  style: TextStyle(color: Colors.grey.shade600, height: 1.4),
                ),
                const SizedBox(height: 32),

                TextFormField(
                  controller: _email,
                  keyboardType: TextInputType.emailAddress,
                  autocorrect: false,
                  decoration: const InputDecoration(
                    labelText: 'Email address',
                    prefixIcon: Icon(Icons.alternate_email),
                  ),
                  validator: (v) =>
                      (v == null || !v.contains('@')) ? 'Enter your email address' : null,
                ),
                const SizedBox(height: 14),

                TextFormField(
                  controller: _password,
                  obscureText: _obscure,
                  decoration: InputDecoration(
                    labelText: 'Password',
                    prefixIcon: const Icon(Icons.lock_outline),
                    suffixIcon: IconButton(
                      icon: Icon(_obscure ? Icons.visibility_off : Icons.visibility),
                      onPressed: () => setState(() => _obscure = !_obscure),
                    ),
                  ),
                  onFieldSubmitted: (_) => _submit(),
                  validator: (v) =>
                      (v == null || v.isEmpty) ? 'Enter your password' : null,
                ),

                if (auth.error != null) ...[
                  const SizedBox(height: 16),
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: RautTheme.danger.withValues(alpha: 0.1),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Row(
                      children: [
                        const Icon(Icons.error_outline, color: RautTheme.danger, size: 18),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            auth.error!,
                            style: const TextStyle(
                              color: RautTheme.danger,
                              fontSize: 13,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],

                const SizedBox(height: 24),
                FilledButton(
                  onPressed: auth.isBusy ? null : _submit,
                  child: auth.isBusy
                      ? const SizedBox(
                          height: 20,
                          width: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Text('Sign in'),
                ),

                const SizedBox(height: 28),
                // Shown deliberately: the single most common setup failure is
                // the app pointing at the wrong host, and it is invisible
                // otherwise.
                // Shown only when this build points somewhere other than
                // production. On a rep's phone it is noise; on a test build it
                // is the one thing that explains why an order never arrived,
                // so it reads as a warning rather than a footnote.
                if (!AppConfig.isProduction)
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: RautTheme.warningBg,
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(color: RautTheme.warning.withValues(alpha: 0.35)),
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Icon(Icons.warning_amber_rounded,
                                size: 14, color: RautTheme.warning),
                            const SizedBox(width: 6),
                            Text(
                              'NOT PRODUCTION',
                              style: TextStyle(
                                fontSize: 10,
                                letterSpacing: 1,
                                fontWeight: FontWeight.w700,
                                color: RautTheme.warning,
                              ),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          AppConfig.apiBase,
                          style: const TextStyle(fontSize: 12, fontFamily: 'monospace'),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Change with --dart-define=RAUT_API_BASE=<url>',
                          style: TextStyle(fontSize: 11, color: Colors.grey.shade600),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
