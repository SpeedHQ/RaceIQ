/**
 * Parse browser information from user agent string
 */
export interface BrowserInfo {
  userAgent: string;
  name: string;
  version: string;
  engine: string;
}

export function detectBrowser(): BrowserInfo {
  const ua = navigator.userAgent;

  let name = "Unknown";
  let version = "Unknown";
  let engine = "Unknown";

  // Parse user agent to detect browser and engine
  if (/Edg/.test(ua)) {
    name = "Edge";
    const match = ua.match(/Edg\/(\d+\.\d+)/);
    version = match ? match[1] : "Unknown";
    engine = "Blink";
  } else if (/Chrome/.test(ua) && !/Chromium/.test(ua)) {
    name = "Chrome";
    const match = ua.match(/Chrome\/(\d+\.\d+)/);
    version = match ? match[1] : "Unknown";
    engine = "Blink";
  } else if (/Safari/.test(ua) && !/Chrome/.test(ua)) {
    name = "Safari";
    const match = ua.match(/Version\/(\d+\.\d+)/);
    version = match ? match[1] : "Unknown";
    engine = "WebKit";
  } else if (/Firefox/.test(ua)) {
    name = "Firefox";
    const match = ua.match(/Firefox\/(\d+\.\d+)/);
    version = match ? match[1] : "Unknown";
    engine = "Gecko";
  } else if (/Chromium/.test(ua)) {
    name = "Chromium";
    const match = ua.match(/Chromium\/(\d+\.\d+)/);
    version = match ? match[1] : "Unknown";
    engine = "Blink";
  }

  return {
    userAgent: ua,
    name,
    version,
    engine,
  };
}
