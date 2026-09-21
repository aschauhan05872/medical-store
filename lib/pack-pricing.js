/** Pack of 180 is the base deal; 90 is costlier per unit; 360 gets extra bulk savings. */
var PACK_SIZES = [90, 180, 360];
var DEFAULT_PACK = 180;

function toMoney(n) {
  var num = Math.round(Number(n) * 100) / 100;
  return isNaN(num) ? 0 : num;
}

function discountPercent(original, discounted) {
  var o = parseFloat(original);
  var d = parseFloat(discounted);
  if (!o || isNaN(o) || isNaN(d) || d >= o) return 0;
  return Math.round(((o - d) / o) * 100);
}

/**
 * Prices are stored for pack of 180.
 * Pack 90: ~15% higher per-unit (costlier).
 * Pack 360: ~5% extra off vs straight 2× of 180.
 */
function getPackQuote(original180, discount180, packSize) {
  var pack = parseInt(packSize, 10);
  if (PACK_SIZES.indexOf(pack) === -1) pack = DEFAULT_PACK;

  var baseOriginal = parseFloat(original180);
  var baseDiscount = parseFloat(discount180);
  if (isNaN(baseOriginal) || baseOriginal <= 0) baseOriginal = baseDiscount;
  if (isNaN(baseDiscount) || baseDiscount < 0) baseDiscount = 0;
  if (!baseOriginal || baseOriginal < baseDiscount) baseOriginal = baseDiscount;

  var original;
  var discounted;

  if (pack === 90) {
    original = toMoney(baseOriginal * 0.5 * 1.15);
    discounted = toMoney(baseDiscount * 0.5 * 1.15);
  } else if (pack === 360) {
    original = toMoney(baseOriginal * 2);
    discounted = toMoney(baseDiscount * 2 * 0.95);
  } else {
    original = toMoney(baseOriginal);
    discounted = toMoney(baseDiscount);
  }

  if (discounted > original) discounted = original;

  var pct = discountPercent(original, discounted);
  var perUnit90 = toMoney((baseDiscount * 0.5 * 1.15) / 90);
  var perUnit180 = toMoney(baseDiscount / 180);
  var betterDealPct = 0;
  if (perUnit90 > 0 && perUnit180 < perUnit90) {
    betterDealPct = Math.round(((perUnit90 - perUnit180) / perUnit90) * 100);
  }

  return {
    packSize: pack,
    original: original,
    discounted: discounted,
    percentOff: pct,
    betterDealPercent: betterDealPct,
    isDefaultPack: pack === DEFAULT_PACK,
    showBetterDealHint: pack === 90 && betterDealPct > 0
  };
}

function normalizePackSize(value) {
  var pack = parseInt(value, 10);
  return PACK_SIZES.indexOf(pack) === -1 ? DEFAULT_PACK : pack;
}

module.exports = {
  PACK_SIZES: PACK_SIZES,
  DEFAULT_PACK: DEFAULT_PACK,
  toMoney: toMoney,
  discountPercent: discountPercent,
  getPackQuote: getPackQuote,
  normalizePackSize: normalizePackSize
};
