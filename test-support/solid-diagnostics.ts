/**
 * Fails Solid-using tests on unexpected ownership diagnostics from Solid's own
 * dev-mode diagnostics channel. Loaded as a Vitest setup file for the `app` and
 * `solid` projects. Findings are collected during the test and asserted during
 * teardown; nothing is thrown from Solid's diagnostic machinery.
 */
import { OBSERVE } from 'solid-js';
import type { DiagnosticCapture, DiagnosticCode, DiagnosticEvent } from 'solid-js';
import { afterEach, beforeEach } from 'vitest';

/** Diagnostics that mean reactive work or cleanup escaped (or misused) an owner. */
export const ownershipDiagnostics: ReadonlySet<DiagnosticCode> = new Set<DiagnosticCode>([
  'NO_OWNER_EFFECT',
  'NO_OWNER_CLEANUP',
  'NO_OWNER_BOUNDARY',
  'RUN_WITH_DISPOSED_OWNER',
  'CLEANUP_IN_FORBIDDEN_SCOPE',
  'SETTLED_CLEANUP_UNOWNED',
  'PRIMITIVE_IN_FORBIDDEN_SCOPE',
]);

const diagnostics = OBSERVE?.diagnostics;
if (typeof diagnostics?.capture !== 'function') {
  throw new Error(
    'Solid diagnostics are unavailable: expected OBSERVE.diagnostics.capture() from the solid-js development build. '
    + "Run Solid tests with the 'development' and 'browser' resolve conditions.",
  );
}

let capture: DiagnosticCapture | undefined;

beforeEach(() => {
  capture = diagnostics.capture();
});

afterEach(() => {
  const active = capture;
  capture = undefined;
  // Always release the capture, even when the assertion below fails.
  const events = active ? active.stop() : [];
  const unexpected = events.filter(event => ownershipDiagnostics.has(event.code));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected Solid ownership diagnostics:\n${unexpected
      .map(event => `  ${event.code}: ${event.message}${event.ownerPath ? ` (at ${event.ownerPath.join(' > ')})` : ''}`)
      .join('\n')}\nIf a test provokes them on purpose, assert them with takeSolidDiagnostics().`);
  }
});

/** Return and clear the diagnostics captured so far in the current test, so an
 * intentional negative test can assert exactly what it provoked.
 */
export function takeSolidDiagnostics(): DiagnosticEvent[] {
  if (!capture) throw new Error('takeSolidDiagnostics() must be called inside a test.');
  const events = [...capture.events];
  capture.clear();
  return events;
}
