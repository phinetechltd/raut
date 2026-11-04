import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  directionsUrl,
  externalMapUrl,
  isPlausibleGoogleApiKey,
  maskKey,
  normaliseProvider,
  resolveMapConfig,
  toClientConfig,
} from "./maps";

const NONE = { provider: null, googleApiKey: null, googleMapId: null };
const KEY = "AIzaSyA1234567890abcdefghijklmnopqrstuv";

describe("resolveMapConfig", () => {
  it("defaults to OpenStreetMap with nothing configured anywhere", () => {
    const cfg = resolveMapConfig(NONE, { provider: "OSM", googleApiKey: null, googleMapId: null });
    assert.equal(cfg.provider, "OSM");
    assert.equal(cfg.providerSource, "platform");
    assert.equal(cfg.google, null);
    assert.equal(cfg.googleAvailable, false);
    assert.equal(cfg.warning, null);
  });

  it("uses Google when the company chose it and supplied a key", () => {
    const cfg = resolveMapConfig(
      { provider: "GOOGLE", googleApiKey: KEY, googleMapId: "abc123def456" },
      { provider: "OSM", googleApiKey: null, googleMapId: null },
    );
    assert.equal(cfg.provider, "GOOGLE");
    assert.equal(cfg.providerSource, "company");
    assert.deepEqual(cfg.google, { apiKey: KEY, mapId: "abc123def456", keySource: "company" });
  });

  it("lets a company choose Google on the platform's shared key", () => {
    const cfg = resolveMapConfig(
      { provider: "GOOGLE", googleApiKey: null, googleMapId: null },
      { provider: "OSM", googleApiKey: KEY, googleMapId: null },
    );
    assert.equal(cfg.provider, "GOOGLE");
    assert.equal(cfg.google?.keySource, "platform");
    assert.equal(cfg.google?.mapId, null);
  });

  it("falls back to OpenStreetMap, with a warning, when Google is chosen without any key", () => {
    const cfg = resolveMapConfig(
      { provider: "GOOGLE", googleApiKey: null, googleMapId: null },
      { provider: "OSM", googleApiKey: null, googleMapId: null },
    );
    assert.equal(cfg.provider, "OSM");
    assert.equal(cfg.requested, "GOOGLE");
    assert.match(cfg.warning ?? "", /no API key/);
  });

  it("a company's own key beats the platform key", () => {
    const cfg = resolveMapConfig(
      { provider: null, googleApiKey: KEY, googleMapId: null },
      { provider: "GOOGLE", googleApiKey: "AIzaSyPLATFORM0000000000000000000000000", googleMapId: "p" },
    );
    assert.equal(cfg.provider, "GOOGLE");
    assert.equal(cfg.google?.apiKey, KEY);
    assert.equal(cfg.google?.keySource, "company");
    // Map ID still inherits when the company has not set one.
    assert.equal(cfg.google?.mapId, "p");
  });

  it("a company can opt out of a platform-wide Google default", () => {
    const cfg = resolveMapConfig(
      { provider: "OSM", googleApiKey: null, googleMapId: null },
      { provider: "GOOGLE", googleApiKey: KEY, googleMapId: null },
    );
    assert.equal(cfg.provider, "OSM");
    assert.equal(cfg.googleAvailable, true);
    assert.equal(cfg.warning, null);
  });

  it("serialises only what the browser needs", () => {
    const cfg = resolveMapConfig(
      { provider: "GOOGLE", googleApiKey: KEY, googleMapId: null },
      { provider: "OSM", googleApiKey: null, googleMapId: null },
    );
    assert.deepEqual(toClientConfig(cfg), { provider: "GOOGLE", google: { apiKey: KEY, mapId: null } });
  });
});

describe("normaliseProvider", () => {
  it("accepts the spellings people actually type", () => {
    assert.equal(normaliseProvider("google"), "GOOGLE");
    assert.equal(normaliseProvider("Google Maps"), "GOOGLE");
    assert.equal(normaliseProvider("osm"), "OSM");
    assert.equal(normaliseProvider("OpenStreetMap"), "OSM");
    assert.equal(normaliseProvider("open-map"), "OSM");
    assert.equal(normaliseProvider("mapbox"), null);
    assert.equal(normaliseProvider(undefined), null);
  });
});

describe("Google key hygiene", () => {
  it("recognises a browser key and rejects other strings", () => {
    assert.equal(isPlausibleGoogleApiKey(KEY), true);
    assert.equal(isPlausibleGoogleApiKey(` ${KEY} `), true);
    assert.equal(isPlausibleGoogleApiKey("sk_live_not_a_maps_key"), false);
    assert.equal(isPlausibleGoogleApiKey("AIza-too-short"), false);
  });

  it("masks a key so a settings page can show it exists without showing it", () => {
    assert.equal(maskKey(KEY), "AIzaSy…stuv");
    assert.equal(maskKey(null), null);
    assert.equal(maskKey("short"), "••••");
  });
});

describe("external links", () => {
  const nairobi = { lat: -1.2864, lng: 36.8172 };

  it("builds provider-specific links the field app mirrors", () => {
    assert.equal(
      directionsUrl("GOOGLE", nairobi),
      "https://www.google.com/maps/dir/?api=1&destination=-1.286400%2C36.817200",
    );
    assert.equal(
      externalMapUrl("OSM", nairobi),
      "https://www.openstreetmap.org/?mlat=-1.286400&mlon=36.817200#map=17/-1.286400/36.817200",
    );
    assert.match(externalMapUrl("GOOGLE", nairobi), /^https:\/\/www\.google\.com\/maps\/search\//);
    assert.match(directionsUrl("OSM", nairobi), /^https:\/\/www\.openstreetmap\.org\/directions\?to=/);
  });
});
