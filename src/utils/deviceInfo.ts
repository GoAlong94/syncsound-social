export interface DeviceInfo {
  os: string;
  browser: string;
}

export const getDeviceInfo = (): DeviceInfo => {
  const userAgent = navigator.userAgent;
  
  // Detect OS
  let os = 'Unknown';
  if (/iPad/.test(userAgent)) {
    os = 'iPadOS';
  } else if (/iPhone|iPod/.test(userAgent)) {
    os = 'iOS';
  } else if (/Android/.test(userAgent)) {
    os = 'Android';
  } else if (/Mac OS X/.test(userAgent)) {
    os = 'macOS';
  } else if (/Windows/.test(userAgent)) {
    os = 'Windows';
  } else if (/Linux/.test(userAgent)) {
    os = 'Linux';
  } else if (/CrOS/.test(userAgent)) {
    os = 'ChromeOS';
  }

  // Detect Browser
  let browser = 'Unknown';
  if (/Edg\//.test(userAgent)) {
    browser = 'Edge';
  } else if (/Chrome/.test(userAgent) && !/Chromium/.test(userAgent)) {
    browser = 'Chrome';
  } else if (/Safari/.test(userAgent) && !/Chrome/.test(userAgent)) {
    browser = 'Safari';
  } else if (/Firefox/.test(userAgent)) {
    browser = 'Firefox';
  } else if (/Opera|OPR/.test(userAgent)) {
    browser = 'Opera';
  } else if (/Trident|MSIE/.test(userAgent)) {
    browser = 'IE';
  }

  return { os, browser };
};

export const getOsIcon = (os: string): string => {
  switch (os) {
    case 'iOS':
    case 'iPadOS':
    case 'macOS':
      return '🍎';
    case 'Android':
      return '🤖';
    case 'Windows':
      return '🪟';
    case 'Linux':
      return '🐧';
    case 'ChromeOS':
      return '💻';
    default:
      return '📱';
  }
};

export const getBrowserIcon = (browser: string): string => {
  switch (browser) {
    case 'Chrome':
      return '🌐';
    case 'Safari':
      return '🧭';
    case 'Firefox':
      return '🦊';
    case 'Edge':
      return '🔵';
    case 'Opera':
      return '🔴';
    default:
      return '🌍';
  }
};
