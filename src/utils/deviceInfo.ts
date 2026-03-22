import { Apple, Chrome, Compass, Monitor, Smartphone, Globe } from 'lucide-react';

export const getDeviceInfo = () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { os: 'Unknown', browser: 'Unknown', userAgent: 'Unknown' };
  }

  let ua = '';
  let touchPoints = 0;

  // 🚀 FIX: Shield against Advanced Tracking Protection crashes
  try {
    ua = navigator.userAgent || '';
    touchPoints = navigator.maxTouchPoints || 0;
  } catch (e) {
    console.warn("Device info blocked by anti-tracking protection.");
  }

  let browser = 'Unknown';
  let os = 'Unknown';

  const isIPad = /Mac/i.test(ua) && touchPoints > 1;

  if (/windows phone/i.test(ua)) os = 'Windows Phone';
  else if (/win/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iPad|iPhone|iPod/i.test(ua) || isIPad) os = 'iOS';
  else if (/mac/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  if (/CriOS/i.test(ua)) browser = 'Chrome';
  else if (/FxiOS/i.test(ua)) browser = 'Firefox';
  else if (/EdgiOS/i.test(ua)) browser = 'Edge';
  else if (/OPiOS/i.test(ua)) browser = 'Opera';
  else if (/Chrome/i.test(ua) && /Edg/i.test(ua)) browser = 'Edge';
  else if (/Chrome/i.test(ua) && /OPR/i.test(ua)) browser = 'Opera';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Safari/i.test(ua) && !/Chrome/i.test(ua)) browser = 'Safari';

  return { os, browser, userAgent: ua };
};

export const getOsIcon = (os: string) => {
  if (os === 'iOS' || os === 'macOS' || os === 'iPadOS') return Apple;
  if (os === 'Android') return Smartphone;
  if (os === 'Windows') return Monitor;
  return Monitor;
};

export const getBrowserIcon = (browser: string) => {
  if (browser.includes('Chrome')) return Chrome;
  if (browser.includes('Safari')) return Compass;
  if (browser.includes('Firefox') || browser.includes('Edge')) return Globe;
  return Globe;
};
