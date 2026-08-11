import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, panelOrigin, resetConfigCache, type AppConfig } from "./index.js";

/** Minimum viable environment — everything else under test is optional. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/sbrbot",
    REDIS_URL: "redis://127.0.0.1:6379",
    ...extra,
  };
}

function load(extra: Record<string, string> = {}): AppConfig {
  resetConfigCache();
  return loadConfig(baseEnv(extra));
}

function loadError(extra: Record<string, string> = {}): string {
  resetConfigCache();
  try {
    loadConfig(baseEnv(extra));
  } catch (error) {
    return error instanceof Error ? error.message : "unknown";
  }
  return "";
}

test("defaults to https with Secure cookies when the scheme is unset", () => {
  const cfg = load();
  assert.equal(cfg.web.scheme, "https");
  assert.equal(cfg.web.secureCookies, true);
  assert.equal(cfg.web.tls, undefined);
});

test("WEB_PANEL_SCHEME=http drops Secure cookies", () => {
  const cfg = load({ WEB_PANEL_SCHEME: "http" });
  assert.equal(cfg.web.scheme, "http");
  assert.equal(cfg.web.secureCookies, false);
});

test("an unrecognised scheme is rejected rather than silently downgraded", () => {
  assert.match(loadError({ WEB_PANEL_SCHEME: "ftp" }), /WEB_PANEL_SCHEME/);
});

test("http in production needs an explicit opt-in", () => {
  const message = loadError({ NODE_ENV: "production", WEB_PANEL_SCHEME: "http" });
  assert.match(message, /plaintext/);

  resetConfigCache();
  const cfg = loadConfig(
    baseEnv({ NODE_ENV: "production", WEB_PANEL_SCHEME: "http", WEB_PANEL_ALLOW_INSECURE: "true" }),
  );
  assert.equal(cfg.web.secureCookies, false);
});

test("https stays allowed in production with no extra ceremony", () => {
  const cfg = load({ NODE_ENV: "production" });
  assert.equal(cfg.web.secureCookies, true);
});

test("a public URL disagreeing with the scheme is an error", () => {
  const message = loadError({ WEB_PANEL_SCHEME: "http", WEB_PANEL_PUBLIC_URL: "https://panel.example.com" });
  assert.match(message, /does not match WEB_PANEL_SCHEME/);
});

test("an https OAuth callback under an http panel is an error", () => {
  const message = loadError({
    WEB_PANEL_SCHEME: "http",
    DISCORD_OAUTH_REDIRECT_URI: "https://panel.example.com/api/auth/callback",
  });
  assert.match(message, /OAuth callback/);
});

test("the default https scheme tolerates a loopback callback (dev boxes have no cert)", () => {
  const cfg = load({ DISCORD_OAUTH_REDIRECT_URI: "http://localhost:3000/api/auth/callback" });
  assert.equal(cfg.web.secureCookies, true);
});

test("the default https scheme rejects a plaintext callback on a real host", () => {
  const message = loadError({ DISCORD_OAUTH_REDIRECT_URI: "http://203.0.113.10:3000/api/auth/callback" });
  assert.match(message, /Secure cookies would be dropped/);
});

test("TLS material must be set as a pair", () => {
  assert.match(loadError({ WEB_PANEL_TLS_CERT: "/etc/ssl/cert.pem" }), /must be set together/);
  const cfg = load({ WEB_PANEL_TLS_CERT: "/etc/ssl/cert.pem", WEB_PANEL_TLS_KEY: "/etc/ssl/key.pem" });
  assert.deepEqual(cfg.web.tls, { certPath: "/etc/ssl/cert.pem", keyPath: "/etc/ssl/key.pem" });
});

test("TLS material under an http scheme is contradictory", () => {
  const message = loadError({
    WEB_PANEL_SCHEME: "http",
    WEB_PANEL_TLS_CERT: "/etc/ssl/cert.pem",
    WEB_PANEL_TLS_KEY: "/etc/ssl/key.pem",
  });
  assert.match(message, /pick one/);
});

test("panelOrigin prefers the explicit public URL", () => {
  const cfg = load({
    WEB_PANEL_SCHEME: "http",
    WEB_PANEL_PUBLIC_URL: "http://203.0.113.10:3000",
    DISCORD_OAUTH_REDIRECT_URI: "http://other.example.com/api/auth/callback",
  });
  assert.equal(panelOrigin(cfg), "http://203.0.113.10:3000");
});

test("panelOrigin falls back to the redirect URI, then to the bind address", () => {
  const withRedirect = load({
    WEB_PANEL_SCHEME: "http",
    DISCORD_OAUTH_REDIRECT_URI: "http://panel.example.com/api/auth/callback",
  });
  assert.equal(panelOrigin(withRedirect), "http://panel.example.com");

  const bare = load({ WEB_PANEL_SCHEME: "http", WEB_PANEL_PORT: "8080" });
  assert.equal(panelOrigin(bare), "http://localhost:8080");
});
