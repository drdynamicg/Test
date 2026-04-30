let adQueue = [];
window.insertAd = function(containerId, adSlot, adFormat = 'auto', adLayoutKey = '') {
  if (typeof adsbygoogle === 'undefined') {
    adQueue.push({ containerId, adSlot, adFormat, adLayoutKey });
  } else {
    actuallyInsertAd(containerId, adSlot, adFormat, adLayoutKey);
  }
};
function actuallyInsertAd(containerId, adSlot, adFormat, adLayoutKey) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = `<ins class="adsbygoogle" style="display:block" data-ad-client="${window.adsensePublisherId}" data-ad-slot="${adSlot}" data-ad-format="${adFormat}" data-full-width-responsive="true" ${adLayoutKey ? `data-ad-layout-key="${adLayoutKey}"` : ''}></ins>`;
  (adsbygoogle = window.adsbygoogle || []).push({});
}
const script = document.createElement('script');
script.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
script.async = true;
script.crossOrigin = 'anonymous';
script.onload = () => { for (const item of adQueue) actuallyInsertAd(item.containerId, item.adSlot, item.adFormat, item.adLayoutKey); adQueue = []; };
document.head.appendChild(script);