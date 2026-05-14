import { initSentry } from "@/lib/telemetry/sentry-init";

// Runs once in the browser before the app boots. No-op when
// NEXT_PUBLIC_SENTRY_DSN is unset.
initSentry("browser");
