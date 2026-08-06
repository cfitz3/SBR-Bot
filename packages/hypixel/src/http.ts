/**
 * Default HttpFetcher backed by the global fetch (Node 18+). Only used at
 * runtime; tests inject a fake fetcher.
 */
import type { HttpFetcher, HttpResponse } from "./ports.js";

export const fetchHttp: HttpFetcher = {
  async get(url, headers): Promise<HttpResponse> {
    const res = await fetch(url, headers ? { headers: headers as Record<string, string> } : {});

    const flat: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      flat[key.toLowerCase()] = value;
    });

    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }

    return { status: res.status, headers: flat, json };
  },
};
