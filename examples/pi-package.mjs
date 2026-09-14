import { createTelemetry } from '@nyn5255/telemetry';

// Your UI must show the collector address, fields, and retention policy BEFORE
// saving explicit consent. A missing preference MUST remain false.
export function telemetryForDebugMode(preferences) {
  return createTelemetry({
    package: 'pi-debug-mode',
    version: '0.1.8',
    enabled: preferences.telemetryConsent === true,
    endpoint: preferences.telemetryEndpoint,
    // Set true only after verifying collector + proxy + CDN logging policy.
    collectorPrivacyAcknowledged: preferences.collectorPrivacyVerified === true,
    features: ['debug'],
  });
}

// After explicit consent and successful package initialization:
// void telemetry.install();
// After the user has finished setup and enabled the package:
// void telemetry.activated('debug');
// After a real successful debug workflow:
// void telemetry.success('debug'); // first_success, weekly_active, then D7
// During actual use (optional if success() already covers the action):
// void telemetry.active('debug');
// In response to a user choosing a feedback button:
// void telemetry.feedback('positive', 'debug');
// When consent is revoked, also persist false in your own preferences:
// telemetry.disable();
