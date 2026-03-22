import { Apple, Chrome, Compass, Monitor, Smartphone, Globe } from 'lucide-react';

export const getDeviceInfo = () => {
  // Safety Check: Prevents fatal crashes during compilation or Server Side Rendering
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { os: 'Unknown', browser: 'Unknown', userAgent: 'Unknown' };
  }

  const ua = navigator.userAgent || '';
  let browser = 'Unknown';
  let os = 'Unknown';

  // Precise OS Detection (with strict iPad Disguise Strip)
  const isIPad = /Mac/i.test(ua) && typeof navigator.maxTouchPoints !== 'undefined' && navigator.maxTouchPoints > 1;

  if (/windows phone/i.test(ua)) os = 'Windows Phone';
  else if (/win/i.test(ua)) os = 'Windows';
  else if (/android/i.test(ua)) os = 'Android';
  else if (/iPad|iPhone|iPod/i.test(ua) || isIPad) os = 'iOS';
  else if (/mac/i.test(ua)) os = 'macOS';
  else if (/linux/i.test(ua)) os = 'Linux';

  // Strict Browser Hierarchy Detection (Solves the iOS Safari/Chrome trap)
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
  if (browser.includes('Firefox')) return Globe;
  if (browser.includes('Edge')) return Globe;
  return Globe;
};
