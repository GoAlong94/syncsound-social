export const getDeviceInfo = () => {
  if (typeof window === 'undefined') {
    return { os: 'Unknown', browser: 'Unknown', userAgent: 'Unknown' };
  }

  const ua = navigator.userAgent;
  let browser = 'Unknown';
  let os = 'Unknown';

  // 1. Precise OS Detection (with iPad Disguise Strip)
  const isIPad = /Mac/.test(ua) && navigator.maxTouchPoints > 1;

  if (/windows phone/i.test(ua)) os = 'Windows Phone';
  else if (/win/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iPad|iPhone|iPod/.test(ua) || isIPad) os = 'iOS';
  else if (/mac/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  // 2. Strict Browser Hierarchy Detection
  if (/CriOS/i.test(ua)) browser = 'Chrome (iOS)';
  else if (/FxiOS/i.test(ua)) browser = 'Firefox (iOS)';
  else if (/EdgiOS/i.test(ua)) browser = 'Edge (iOS)';
  else if (/OPiOS/i.test(ua)) browser = 'Opera (iOS)';
  else if (/Chrome/i.test(ua) && /Edg/i.test(ua)) browser = 'Edge';
  else if (/Chrome/i.test(ua) && /OPR/i.test(ua)) browser = 'Opera';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  return { os, browser, userAgent: ua };
};
