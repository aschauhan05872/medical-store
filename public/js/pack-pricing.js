(function () {
  function money(n) {
    return Math.round(Number(n) * 100) / 100;
  }

  function formatUsd(n) {
    return '$' + money(n).toFixed(2) + ' USD';
  }

  function quote(original180, discount180, pack) {
    var baseO = parseFloat(original180);
    var baseD = parseFloat(discount180);
    if (isNaN(baseO) || baseO <= 0) baseO = baseD;
    if (isNaN(baseD) || baseD < 0) baseD = 0;
    if (!baseO || baseO < baseD) baseO = baseD;

    var original;
    var discounted;
    if (pack === 90) {
      original = money(baseO * 0.5 * 1.15);
      discounted = money(baseD * 0.5 * 1.15);
    } else if (pack === 360) {
      original = money(baseO * 2);
      discounted = money(baseD * 2 * 0.95);
    } else {
      original = money(baseO);
      discounted = money(baseD);
    }
    if (discounted > original) discounted = original;

    var pct = 0;
    if (original > 0 && discounted < original) {
      pct = Math.round(((original - discounted) / original) * 100);
    }

    var per90 = money((baseD * 0.5 * 1.15) / 90);
    var per180 = money(baseD / 180);
    var better = 0;
    if (per90 > 0 && per180 < per90) {
      better = Math.round(((per90 - per180) / per90) * 100);
    }

    return { original: original, discounted: discounted, percentOff: pct, betterDealPercent: better };
  }

  function renderPrice(el, q) {
    if (!el) return;
    var html = '';
    if (q.percentOff > 0) {
      html += '<span class="price-original">' + formatUsd(q.original) + '</span> ';
    }
    html += '<span class="price-sale">' + formatUsd(q.discounted) + '</span>';
    if (q.percentOff > 0) {
      html += ' <span class="price-badge">' + q.percentOff + '% OFF</span>';
    }
    el.innerHTML = html;
  }

  function init() {
    var root = document.getElementById('pack-pricing-root');
    if (!root) return;

    var original180 = root.getAttribute('data-original');
    var discount180 = root.getAttribute('data-discount');
    var select = document.getElementById('pack_size');
    var priceEl = document.getElementById('dynamic-product-price');
    var hintEl = document.getElementById('pack-deal-hint');
    var buyNow = document.getElementById('buy-now-link');
    var productId = root.getAttribute('data-product-id');

    function sync() {
      var pack = parseInt(select.value, 10) || 180;
      var q = quote(original180, discount180, pack);
      renderPrice(priceEl, q);

      if (hintEl) {
        if (pack === 90 && q.betterDealPercent > 0) {
          hintEl.hidden = false;
          hintEl.textContent =
            'For a better deal, select Pack of 180 and get an additional ' +
            q.betterDealPercent +
            '% off.';
        } else {
          hintEl.hidden = true;
          hintEl.textContent = '';
        }
      }

      if (buyNow && productId) {
        buyNow.setAttribute('href', '/checkout?product_id=' + productId + '&pack_size=' + pack);
      }
    }

    if (select) {
      select.addEventListener('change', sync);
      sync();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
