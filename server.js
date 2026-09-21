const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const seedMedicines = require('./lib/seed-medicines');
const { validateCheckout } = require('./lib/checkout-validation');
const {
  PACK_SIZES,
  DEFAULT_PACK,
  getPackQuote,
  normalizePackSize
} = require('./lib/pack-pricing');

/**
 * Minimal .env loader (no external dependency — npm registry isn't reachable
 * in every environment this runs in). Reads KEY=VALUE lines from .env in the
 * project root into process.env, without overriding vars already set.
 */
function loadEnvFile() {
  var envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  var content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach(function (line) {
    line = line.trim();
    if (!line || line.indexOf('#') === 0) return;
    var idx = line.indexOf('=');
    if (idx === -1) return;
    var key = line.slice(0, idx).trim();
    var val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  });
}
loadEnvFile();

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8080;
/** Tor hidden-service safety: never bind to 0.0.0.0 — loopback only via reverse proxy. */
const HOST = '127.0.0.1';
if (HOST !== '127.0.0.1') {
  throw new Error('Server must bind to 127.0.0.1 to prevent IP leakage');
}

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!ADMIN_PASSWORD || !SESSION_SECRET) {
  console.error(
    'Missing ADMIN_PASSWORD and/or SESSION_SECRET. Create a .env file in the medical-store folder ' +
    '(see .env.example) before starting the server.'
  );
  process.exit(1);
}

var ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

const US_STATES = [
  { code: 'AL', name: 'Alabama' }, { code: 'AK', name: 'Alaska' }, { code: 'AZ', name: 'Arizona' },
  { code: 'AR', name: 'Arkansas' }, { code: 'CA', name: 'California' }, { code: 'CO', name: 'Colorado' },
  { code: 'CT', name: 'Connecticut' }, { code: 'DE', name: 'Delaware' }, { code: 'DC', name: 'District of Columbia' },
  { code: 'FL', name: 'Florida' }, { code: 'GA', name: 'Georgia' }, { code: 'HI', name: 'Hawaii' },
  { code: 'ID', name: 'Idaho' }, { code: 'IL', name: 'Illinois' }, { code: 'IN', name: 'Indiana' },
  { code: 'IA', name: 'Iowa' }, { code: 'KS', name: 'Kansas' }, { code: 'KY', name: 'Kentucky' },
  { code: 'LA', name: 'Louisiana' }, { code: 'ME', name: 'Maine' }, { code: 'MD', name: 'Maryland' },
  { code: 'MA', name: 'Massachusetts' }, { code: 'MI', name: 'Michigan' }, { code: 'MN', name: 'Minnesota' },
  { code: 'MS', name: 'Mississippi' }, { code: 'MO', name: 'Missouri' }, { code: 'MT', name: 'Montana' },
  { code: 'NE', name: 'Nebraska' }, { code: 'NV', name: 'Nevada' }, { code: 'NH', name: 'New Hampshire' },
  { code: 'NJ', name: 'New Jersey' }, { code: 'NM', name: 'New Mexico' }, { code: 'NY', name: 'New York' },
  { code: 'NC', name: 'North Carolina' }, { code: 'ND', name: 'North Dakota' }, { code: 'OH', name: 'Ohio' },
  { code: 'OK', name: 'Oklahoma' }, { code: 'OR', name: 'Oregon' }, { code: 'PA', name: 'Pennsylvania' },
  { code: 'RI', name: 'Rhode Island' }, { code: 'SC', name: 'South Carolina' }, { code: 'SD', name: 'South Dakota' },
  { code: 'TN', name: 'Tennessee' }, { code: 'TX', name: 'Texas' }, { code: 'UT', name: 'Utah' },
  { code: 'VT', name: 'Vermont' }, { code: 'VA', name: 'Virginia' }, { code: 'WA', name: 'Washington' },
  { code: 'WV', name: 'West Virginia' }, { code: 'WI', name: 'Wisconsin' }, { code: 'WY', name: 'Wyoming' }
];

const COLLECTIONS = {
  all: { title: 'All Medicines', desc: 'Browse our complete catalog of prescription medications, pain relief, and wellness supplements.' },
  prescription: { title: 'Prescription Medications', desc: 'Physician-directed medications dispensed with full clinical documentation and verification.' },
  wellness: { title: 'Wellness & Supplements', desc: 'Premium vitamins and supplements supporting daily health and immune function.' },
  'pain-relief': { title: 'Pain Relief', desc: 'Over-the-counter and physician-guided options for pain and inflammation management.' }
};

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

var ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml'];
var ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.svg'];

const storage = multer.diskStorage({
  destination: function (req, file, cb) { cb(null, uploadsDir); },
  filename: function (req, file, cb) { cb(null, Date.now() + path.extname(file.originalname).toLowerCase()); }
});
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: function (req, file, cb) {
    var ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_IMAGE_MIME_TYPES.indexOf(file.mimetype) === -1 || ALLOWED_IMAGE_EXTENSIONS.indexOf(ext) === -1) {
      return cb(new Error('INVALID_FILE_TYPE'));
    }
    cb(null, true);
  }
});

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false }
}));

function requireAdmin(req, res, next) {
  if (!req.session.isAdmin) return res.redirect('/admin-login');
  next();
}

const db = new sqlite3.Database(path.join(__dirname, 'database.db'));

function migrateColumns() {
  ['category TEXT', 'slug TEXT', 'original_price_usd TEXT', 'stock_quantity INTEGER'].forEach(function (col) {
    db.run('ALTER TABLE products ADD COLUMN ' + col, function () {});
  });
  [
    'first_name TEXT', 'last_name TEXT', 'email TEXT', 'contact_number TEXT',
    'shipping_street TEXT', 'shipping_city TEXT', 'shipping_state TEXT', 'shipping_postal TEXT', 'shipping_country TEXT',
    'billing_street TEXT', 'billing_city TEXT', 'billing_state TEXT', 'billing_postal TEXT', 'billing_country TEXT',
    'secondary_phone TEXT', 'shipping_line2 TEXT', 'billing_line2 TEXT', 'billing_first_name TEXT', 'billing_last_name TEXT',
    'shipping_method TEXT', 'order_notes TEXT', 'marketing_consent INTEGER', 'terms_accepted INTEGER', 'cart_snapshot TEXT',
    "status TEXT DEFAULT 'pending'", 'tracking_number TEXT', 'carrier TEXT', 'status_updated_at DATETIME'
  ].forEach(function (col) {
    db.run('ALTER TABLE leads ADD COLUMN ' + col, function () {});
  });
}

db.serialize(function () {
  db.run(
    'CREATE TABLE IF NOT EXISTS products (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, price_usd TEXT NOT NULL, ' +
      'description TEXT, dosage_strength TEXT, precautions TEXT, image TEXT, category TEXT, slug TEXT' +
    ')'
  );
  db.run(
    'CREATE TABLE IF NOT EXISTS leads (' +
      'id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, ' +
      'contact_handle TEXT, destination_country TEXT, selected_product_id INTEGER, ' +
      'first_name TEXT, last_name TEXT, email TEXT, contact_number TEXT, ' +
      'shipping_street TEXT, shipping_city TEXT, shipping_state TEXT, shipping_postal TEXT, shipping_country TEXT, ' +
      'billing_street TEXT, billing_city TEXT, billing_state TEXT, billing_postal TEXT, billing_country TEXT, ' +
      'secondary_phone TEXT, shipping_line2 TEXT, billing_line2 TEXT, billing_first_name TEXT, billing_last_name TEXT, ' +
      'shipping_method TEXT, order_notes TEXT, marketing_consent INTEGER, terms_accepted INTEGER, cart_snapshot TEXT' +
    ')'
  );
  migrateColumns();
  seedCatalog();
});

function seedCatalog() {
  db.get("SELECT COUNT(*) AS count FROM products WHERE slug IS NOT NULL AND slug != ''", [], function (err, row) {
    if (err) return;
    if (!row || row.count < seedMedicines.length) {
      db.run('DELETE FROM products', [], function () {
        var stmt = db.prepare(
          'INSERT INTO products (title, price_usd, original_price_usd, description, dosage_strength, precautions, image, category, slug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        seedMedicines.forEach(function (med) {
          stmt.run([
            med.title, med.price_usd, med.original_price_usd, med.description,
            med.dosage_strength, med.precautions, med.image, med.category, med.slug
          ]);
        });
        stmt.finalize();
        console.log('Seeded ' + seedMedicines.length + ' medicines');
      });
      return;
    }
    seedMedicines.forEach(function (med) {
      db.run(
        'UPDATE products SET price_usd = ?, original_price_usd = ?, title = ?, description = ?, dosage_strength = ?, precautions = ?, image = ?, category = ? WHERE slug = ?',
        [med.price_usd, med.original_price_usd, med.title, med.description, med.dosage_strength, med.precautions, med.image, med.category, med.slug]
      );
    });
  });
}

function readView(filename) {
  return fs.readFileSync(path.join(__dirname, 'views', filename), 'utf8');
}

function readPartial(name) {
  return fs.readFileSync(path.join(__dirname, 'views', 'partials', name + '.html'), 'utf8');
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatPriceUsd(price) {
  var num = parseFloat(price);
  if (isNaN(num)) return escapeHtml(String(price || '')) + ' USD';
  return '$' + num.toFixed(2) + ' USD';
}

function productOriginal(p) {
  var original = parseFloat(p && p.original_price_usd);
  var sale = parseFloat(p && p.price_usd);
  if (!isNaN(original) && original > 0) return original;
  if (!isNaN(sale)) return sale;
  return 0;
}

function productSale(p) {
  var sale = parseFloat(p && p.price_usd);
  return isNaN(sale) ? 0 : sale;
}

/** stock_quantity of null/undefined means "not tracked" — treated as always in stock. */
function stockValue(p) {
  if (!p || p.stock_quantity === null || p.stock_quantity === undefined || p.stock_quantity === '') return null;
  var n = parseInt(p.stock_quantity, 10);
  return isNaN(n) ? null : n;
}

function isOutOfStock(p) {
  var s = stockValue(p);
  return s !== null && s <= 0;
}

function buildStockBadge(p) {
  var s = stockValue(p);
  if (s === null) return '';
  if (s <= 0) return '<span class="stock-badge stock-badge-out">Out of Stock</span>';
  if (s <= 10) return '<span class="stock-badge stock-badge-low">Only ' + s + ' left</span>';
  return '<span class="stock-badge stock-badge-in">In Stock</span>';
}

function buildPriceHtml(original, discounted, options) {
  options = options || {};
  var quote = typeof original === 'object' && original.discounted != null
    ? original
    : getPackQuote(original, discounted, options.packSize || DEFAULT_PACK);
  var suffix = options.suffix ? ' ' + escapeHtml(options.suffix) : '';
  var html = '<span class="price-block">';
  if (quote.percentOff > 0) {
    html += '<span class="price-original">' + formatPriceUsd(quote.original) + '</span> ';
  }
  html += '<span class="price-sale">' + formatPriceUsd(quote.discounted) + suffix + '</span>';
  if (quote.percentOff > 0) {
    html += ' <span class="price-badge">' + quote.percentOff + '% OFF</span>';
  }
  html += '</span>';
  return html;
}

function buildPackSelectHtml(selectedPack) {
  var selected = normalizePackSize(selectedPack);
  return (
    '<label class="pack-size-label" for="pack_size">Pack size</label>' +
    '<select id="pack_size" name="pack_size" class="pack-size-select" required>' +
      PACK_SIZES.map(function (size) {
        var sel = size === selected ? ' selected' : '';
        var note = size === DEFAULT_PACK ? ' (Best value)' : '';
        return '<option value="' + size + '"' + sel + '>Pack of ' + size + note + '</option>';
      }).join('') +
    '</select>'
  );
}

function truncateText(text, maxLen) {
  var safe = String(text || '');
  if (safe.length <= maxLen) return escapeHtml(safe);
  return escapeHtml(safe.substring(0, maxLen).trim()) + '&hellip;';
}

function getCart(req) {
  if (!req.session.cart) req.session.cart = [];
  return req.session.cart;
}

function getCartCount(req) {
  return getCart(req).reduce(function (sum, item) { return sum + item.quantity; }, 0);
}

function renderLayout(html, req) {
  var header = readPartial('header').replace('<!-- CART_COUNT -->', String(getCartCount(req)));
  var footer = readPartial('footer').replace('<!-- YEAR -->', String(new Date().getFullYear()));
  return html.replace('<!-- HEADER -->', header).replace('<!-- FOOTER -->', footer);
}

function renderPage(viewPath, req, replacements) {
  var html = readView(viewPath);
  Object.keys(replacements || {}).forEach(function (key) {
    html = html.split('<!-- ' + key + ' -->').join(replacements[key]);
  });
  return renderLayout(html, req);
}

function productImageSrc(p) {
  if (!p || !p.image) return null;
  if (p.image.indexOf('products/') === 0) return '/images/' + p.image;
  return '/uploads/' + p.image;
}

function buildMedicalImageAlt(p) {
  var title = p.title || 'Clinical Asset';
  var dosage = p.dosage_strength || 'verified dosage';
  var quote = getPackQuote(productOriginal(p), productSale(p), p.packSize || DEFAULT_PACK);
  var price = formatPriceUsd(quote.discounted);
  return 'Med Doorshipp - ' + title + ' - ' + dosage + ' - Executive Prescription Delivery ' + price;
}

function buildProductImage(p, cssClass, wrapped) {
  var alt = escapeHtml(buildMedicalImageAlt(p));
  var src = productImageSrc(p);
  var inner = src
    ? '<img src="' + escapeHtml(src) + '" alt="' + alt + '" class="' + cssClass + '">'
    : '<div class="product-image-placeholder" aria-label="' + alt + '">Medicine Preview</div>';
  return wrapped ? '<div class="product-image-wrap">' + inner + '</div>' : inner;
}

function buildPrecautionsDrawer(productId, precautionsText) {
  var safeText = escapeHtml(precautionsText || 'Consult your attending physician prior to dispensation.');
  var lines = safeText.split('\n').filter(function (l) { return l.trim().length > 0; });
  var bodyContent = lines.length === 0
    ? '<p class="drawer-text">' + safeText + '</p>'
    : lines.map(function (line) { return '<p class="drawer-text">' + line.trim() + '</p>'; }).join('');
  return (
    '<details class="luxury-drawer" id="precautions-' + productId + '">' +
      '<summary class="luxury-drawer-trigger">Medical Precautions &amp; Contraindications</summary>' +
      '<div class="luxury-drawer-panel"><h4 class="drawer-title">Clinical Safety Advisory</h4>' + bodyContent +
      '<p class="drawer-note">Review all precautions before requesting door delivery.</p></div></details>'
  );
}

function buildCatalogCard(p) {
  var quote = getPackQuote(productOriginal(p), productSale(p), DEFAULT_PACK);
  var outOfStock = isOutOfStock(p);
  var addToCartControl = outOfStock
    ? '<button type="button" class="btn-primary" disabled>Out of Stock</button>'
    : (
      '<form action="/cart/add" method="POST" class="inline-form ajax-cart-form" data-product-id="' + p.id + '">' +
        '<input type="hidden" name="product_id" value="' + p.id + '">' +
        '<input type="hidden" name="pack_size" value="' + DEFAULT_PACK + '">' +
        '<label class="qty-mini-label" for="qty-' + p.id + '">Qty</label>' +
        '<input type="number" id="qty-' + p.id + '" name="quantity" value="1" min="1" max="99" class="qty-mini-input">' +
        '<button type="submit" class="btn-primary" data-processing-label="Adding…" data-added-label="Added ✓">Add to Cart</button>' +
      '</form>'
    );
  return (
    '<article class="product-card">' +
      '<a href="/product/' + p.id + '">' + buildProductImage(p, 'product-image', true) + '</a>' +
      '<div class="product-card-body">' +
        '<p class="product-meta-line">' + escapeHtml(p.category || 'medicine') + ' · Dosage Potency: ' + escapeHtml(p.dosage_strength) + ' ' + buildStockBadge(p) + '</p>' +
        '<h2 class="product-title"><a href="/product/' + p.id + '">' + escapeHtml(p.title) + '</a></h2>' +
        '<p class="product-price">' + buildPriceHtml(quote) + '</p>' +
        '<p class="product-pack-note">Shown for Pack of ' + DEFAULT_PACK + '</p>' +
        '<p class="product-description">' + truncateText(p.description, 100) + '</p>' +
        '<div class="product-actions">' +
          '<a href="/product/' + p.id + '" class="btn-secondary">View Details</a>' +
          addToCartControl +
        '</div>' +
        '<p class="cart-qty-note" data-cart-note-for="' + p.id + '" hidden></p>' +
      '</div></article>'
  );
}

function buildStateOptions() {
  return US_STATES.map(function (s) {
    return '<option value="' + s.code + '">' + escapeHtml(s.name) + '</option>';
  }).join('');
}

function buildStateOptionsSelected(selectedCode) {
  return US_STATES.map(function (s) {
    var sel = s.code === selectedCode ? ' selected' : '';
    return '<option value="' + s.code + '"' + sel + '>' + escapeHtml(s.name) + '</option>';
  }).join('');
}

var CHECKOUT_FORM_FIELDS = [
  'email', 'contact_number', 'secondary_phone', 'first_name', 'last_name',
  'shipping_street', 'shipping_line2', 'shipping_city', 'shipping_state', 'shipping_postal',
  'billing_first_name', 'billing_last_name', 'billing_street', 'billing_line2',
  'billing_city', 'billing_state', 'billing_postal', 'order_notes'
];

function buildCheckoutReplacements(body, errors) {
  body = body || {};
  errors = errors || {};
  var rep = {};
  CHECKOUT_FORM_FIELDS.forEach(function (field) {
    rep['VALUE_' + field] = escapeHtml(body[field] || '');
    rep['CLASS_' + field] = errors[field] ? 'input-invalid' : '';
    rep['ERROR_' + field] = escapeHtml(errors[field] || '');
  });
  rep.BILLING_SAME_CHECKED = body.billing_same_as_shipping === 'on' || body.billing_same_as_shipping === undefined ? 'checked' : '';
  rep.TERMS_CHECKED = body.terms_accepted === 'on' ? 'checked' : '';
  rep.MARKETING_CHECKED = body.marketing_consent === 'on' ? 'checked' : '';
  rep.CHECKOUT_FORM_ERROR = Object.keys(errors).length > 0
    ? 'Please correct the highlighted fields before submitting.'
    : '';
  return rep;
}

function renderCheckoutPage(req, products, body, errors) {
  body = body || {};
  errors = errors || {};
  var html = renderPage('checkout.html', req, buildCheckoutReplacements(body, errors));
  html = html.replace('<!-- ORDER_SUMMARY -->', buildOrderSummaryItems(products));
  html = html.replace('<!-- PRODUCT_ID -->', products.length === 1 ? String(products[0].id) : escapeHtml(body.product_id || ''));
  html = html.replace('<!-- US_STATES_OPTIONS -->', buildStateOptionsSelected(body.shipping_state || ''));
  html = html.replace('<!-- US_STATES_OPTIONS -->', buildStateOptionsSelected(body.billing_state || ''));
  if (Object.keys(errors).length > 0) {
    html = html.replace('id="checkout-form-error" class="checkout-form-error" role="alert" hidden', 'id="checkout-form-error" class="checkout-form-error" role="alert"');
    Object.keys(errors).forEach(function (key) {
      html = html.replace('id="' + key + '_error" class="field-error" hidden', 'id="' + key + '_error" class="field-error"');
    });
  }
  return html;
}

function buildOrderSummaryItems(products) {
  if (!products || products.length === 0) {
    return '<p class="order-summary-empty">Your cart is empty. <a href="/collections">Browse medicines</a></p>';
  }
  var html = '';
  var subtotal = 0;
  products.forEach(function (p) {
    var quote = getPackQuote(productOriginal(p), productSale(p), p.packSize || DEFAULT_PACK);
    var lineTotal = quote.discounted * p.cartQty;
    subtotal += lineTotal;
    var src = productImageSrc(p);
    var img = src
      ? '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(buildMedicalImageAlt(p)) + '" class="cart-line-image">'
      : '<div class="cart-line-image cart-line-placeholder" aria-label="' + escapeHtml(buildMedicalImageAlt(p)) + '"></div>';
    html +=
      '<div class="cart-line-item">' + img +
        '<div class="cart-line-details">' +
          '<h3>' + escapeHtml(p.title) + '</h3>' +
          '<p class="order-summary-meta">Qty ' + p.cartQty + ' · Pack of ' + quote.packSize + ' · ' + escapeHtml(p.dosage_strength) + '</p>' +
          '<p class="order-summary-price">' + buildPriceHtml(quote) + '</p>' +
          (p.cartQty > 1 ? '<p class="order-summary-meta">Line total: ' + formatPriceUsd(lineTotal) + '</p>' : '') +
        '</div></div>';
  });
  html += '<div class="cart-subtotal-row"><span>Subtotal (USD)</span><span>' + formatPriceUsd(subtotal) + '</span></div>';
  return html;
}

function maskPhone(phone) {
  var digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 4) return escapeHtml(phone || '');
  return '***-***-' + escapeHtml(digits.slice(-4));
}

function buildRequestNumber(leadId) {
  return 'MD-' + String(leadId).padStart(6, '0');
}

function loadCartProducts(req, callback) {
  var cart = getCart(req);
  if (cart.length === 0) return callback(null, []);
  var ids = cart.map(function (c) { return c.product_id; });
  var placeholders = ids.map(function () { return '?'; }).join(',');
  db.all('SELECT * FROM products WHERE id IN (' + placeholders + ')', ids, function (err, products) {
    if (err) return callback(err);
    var merged = [];
    cart.forEach(function (cartItem) {
      var p = products.find(function (row) { return row.id === cartItem.product_id; });
      if (!p) return;
      merged.push(Object.assign({}, p, {
        cartQty: cartItem.quantity || 1,
        packSize: normalizePackSize(cartItem.pack_size)
      }));
    });
    callback(null, merged);
  });
}

function buildCategoryFilters(active) {
  var cats = [
    { key: '', label: 'All' },
    { key: 'prescription', label: 'Prescription' },
    { key: 'wellness', label: 'Wellness' },
    { key: 'pain-relief', label: 'Pain Relief' }
  ];
  return cats.map(function (c) {
    var href = c.key ? '/collections?category=' + c.key : '/collections';
    var cls = (active || '') === c.key ? 'filter-pill active' : 'filter-pill';
    return '<a href="' + href + '" class="' + cls + '">' + c.label + '</a>';
  }).join('');
}

app.get('/', function (req, res) {
  db.all('SELECT * FROM products ORDER BY id ASC', [], function (err, products) {
    if (err) return res.status(500).send('Database error');
    var productHtml = !products || products.length === 0
      ? '<p class="no-products">Our pharmacy catalog is being updated. Please check back soon.</p>'
      : products.map(buildCatalogCard).join('');
    res.type('html').send(renderPage('index.html', req, { PRODUCTS_PLACEHOLDER: productHtml }));
  });
});

app.get('/collections', function (req, res) {
  var category = req.query.category || '';
  var meta = COLLECTIONS[category] || COLLECTIONS.all;
  var query = category
    ? 'SELECT * FROM products WHERE category = ? ORDER BY id ASC'
    : 'SELECT * FROM products ORDER BY id ASC';
  var params = category ? [category] : [];
  db.all(query, params, function (err, products) {
    if (err) return res.status(500).send('Database error');
    var productHtml = !products || products.length === 0
      ? '<p class="no-products">No medicines in this collection yet.</p>'
      : products.map(buildCatalogCard).join('');
    res.type('html').send(renderPage('collections.html', req, {
      COLLECTION_TITLE: escapeHtml(meta.title),
      COLLECTION_DESC: escapeHtml(meta.desc),
      CATEGORY_FILTERS: buildCategoryFilters(category),
      PRODUCTS_PLACEHOLDER: productHtml
    }));
  });
});

app.get('/product/:id', function (req, res) {
  db.get('SELECT * FROM products WHERE id = ?', [req.params.id], function (err, p) {
    if (err) return res.status(500).send('Database error');
    if (!p) {
      return res.status(404).send(renderLayout(
        '<main class="page-centered section-padding"><div class="container-shell success-card"><h1>Medicine Not Found</h1><p><a href="/collections" class="btn-primary">Browse Catalog</a></p></div></main>', req
      ));
    }
    var quote = getPackQuote(productOriginal(p), productSale(p), DEFAULT_PACK);
    var html = renderPage('product.html', req, {});
    html = html.replace(/<!-- PRODUCT_TITLE -->/g, escapeHtml(p.title));
    html = html.replace('<!-- PRODUCT_PRICE -->', buildPriceHtml(quote));
    html = html.replace('<!-- PRODUCT_DOSAGE -->', escapeHtml(p.dosage_strength));
    html = html.replace('<!-- PRODUCT_DESCRIPTION -->', escapeHtml(p.description));
    html = html.replace('<!-- PRODUCT_IMAGE -->', buildProductImage(p, 'product-image'));
    html = html.replace(/<!-- PRODUCT_ID -->/g, String(p.id));
    html = html.replace('<!-- PRECAUTIONS_BLOCK -->', buildPrecautionsDrawer(p.id, p.precautions));
    html = html.replace('<!-- PRODUCT_CATEGORY -->', escapeHtml(p.category || 'medicine'));
    html = html.replace('<!-- PACK_SELECT -->', buildPackSelectHtml(DEFAULT_PACK));
    html = html.replace('<!-- ORIGINAL_PRICE_VALUE -->', String(productOriginal(p)));
    html = html.replace('<!-- DISCOUNT_PRICE_VALUE -->', String(productSale(p)));
    html = html.replace('<!-- STOCK_BADGE -->', buildStockBadge(p));
    if (isOutOfStock(p)) {
      html = html.replace('<!-- OUT_OF_STOCK_DISABLED -->', 'disabled');
    } else {
      html = html.replace('<!-- OUT_OF_STOCK_DISABLED -->', '');
    }
    res.type('html').send(html);
  });
});

app.post('/cart/add', function (req, res) {
  var productId = parseInt(req.body.product_id, 10);
  var quantity = parseInt(req.body.quantity, 10) || 1;
  if (quantity < 1) quantity = 1;
  if (quantity > 99) quantity = 99;
  var packSize = normalizePackSize(req.body.pack_size);
  var isAjax = req.get('X-Requested-With') === 'fetch';
  db.get('SELECT * FROM products WHERE id = ?', [productId], function (err, p) {
    var redirect = req.body.redirect || req.get('Referer') || '/cart';
    if (err || !p || isOutOfStock(p)) {
      if (isAjax) return res.status(400).json({ ok: false, error: 'unavailable' });
      return res.redirect(redirect);
    }
    var stock = stockValue(p);
    var cart = getCart(req);
    var existing = cart.find(function (c) {
      return c.product_id === productId && normalizePackSize(c.pack_size) === packSize;
    });
    var nextQty = (existing ? existing.quantity : 0) + quantity;
    if (stock !== null && nextQty > stock) nextQty = stock;
    if (nextQty <= 0) {
      if (isAjax) return res.status(400).json({ ok: false, error: 'out_of_stock' });
      return res.redirect(redirect);
    }
    if (existing) existing.quantity = nextQty;
    else cart.push({ product_id: productId, quantity: nextQty, pack_size: packSize });
    if (isAjax) {
      return res.json({
        ok: true,
        cartCount: getCartCount(req),
        productId: productId,
        packSize: packSize,
        quantityInCart: nextQty
      });
    }
    res.redirect(redirect);
  });
});

app.post('/cart/update', function (req, res) {
  var productId = parseInt(req.body.product_id, 10);
  var quantity = parseInt(req.body.quantity, 10);
  var packSize = normalizePackSize(req.body.pack_size);
  var cart = getCart(req).filter(function (c) {
    return !(c.product_id === productId && normalizePackSize(c.pack_size) === packSize);
  });
  if (quantity > 0) cart.push({ product_id: productId, quantity: quantity, pack_size: packSize });
  req.session.cart = cart;
  res.redirect('/cart');
});

app.post('/cart/remove', function (req, res) {
  var productId = parseInt(req.body.product_id, 10);
  var packSize = normalizePackSize(req.body.pack_size);
  req.session.cart = getCart(req).filter(function (c) {
    return !(c.product_id === productId && normalizePackSize(c.pack_size) === packSize);
  });
  res.redirect('/cart');
});

app.get('/cart', function (req, res) {
  loadCartProducts(req, function (err, products) {
    if (err) return res.status(500).send('Database error');
    var content = '';
    var checkoutCta = '';
    if (products.length === 0) {
      content = '<div class="cart-empty"><p>Your cart is empty.</p><a href="/collections" class="btn-primary">Browse Medicines</a></div>';
    } else {
      content = '<div class="cart-items-list">';
      products.forEach(function (p) {
        var quote = getPackQuote(productOriginal(p), productSale(p), p.packSize);
        var src = productImageSrc(p);
        content +=
          '<article class="cart-page-item">' +
            (src ? '<img src="' + escapeHtml(src) + '" alt="' + escapeHtml(buildMedicalImageAlt(p)) + '" class="cart-line-image">' : '<div class="cart-line-image cart-line-placeholder" aria-label="' + escapeHtml(buildMedicalImageAlt(p)) + '"></div>') +
            '<div class="cart-line-details">' +
              '<h2>' + escapeHtml(p.title) + '</h2>' +
              '<p class="order-summary-meta">' + escapeHtml(p.dosage_strength) + ' · Pack of ' + quote.packSize + '</p>' +
              '<p class="order-summary-price">' + buildPriceHtml(quote, null, { suffix: 'each' }) + '</p>' +
              '<form action="/cart/update" method="POST" class="cart-qty-form">' +
                '<input type="hidden" name="product_id" value="' + p.id + '">' +
                '<input type="hidden" name="pack_size" value="' + quote.packSize + '">' +
                '<label>Qty <input type="number" name="quantity" value="' + p.cartQty + '" min="1" max="99"></label>' +
                '<button type="submit" class="btn-secondary btn-sm" data-processing-label="Updating…">Update</button>' +
              '</form>' +
              '<form action="/cart/remove" method="POST" class="inline-form">' +
                '<input type="hidden" name="product_id" value="' + p.id + '">' +
                '<input type="hidden" name="pack_size" value="' + quote.packSize + '">' +
                '<button type="submit" class="btn-ghost" data-processing-label="Removing…">Remove</button>' +
              '</form>' +
            '</div></article>';
      });
      content += '</div>';
      checkoutCta = '<a href="/checkout" class="btn-primary" id="cart-checkout-link">Continue to Checkout</a>';
    }
    res.type('html').send(renderPage('cart.html', req, { CART_CONTENT: content, CHECKOUT_CTA: checkoutCta }));
  });
});

app.get('/checkout', function (req, res) {
  var productId = req.query.product_id || req.query.id;
  var packSize = normalizePackSize(req.query.pack_size);
  function sendCheckout(products) {
    res.type('html').send(renderCheckoutPage(req, products, {}, {}));
  }
  if (productId) {
    db.get('SELECT * FROM products WHERE id = ?', [productId], function (err, p) {
      sendCheckout(p ? [Object.assign({}, p, { cartQty: 1, packSize: packSize })] : []);
    });
    return;
  }
  loadCartProducts(req, function (err, products) {
    if (err) return res.status(500).send('Database error');
    sendCheckout(products);
  });
});

function buildConfirmationPage(req, leadId, orderData, products) {
  var secondaryNote = orderData.secondary_phone
    ? '<p class="editorial-lead" style="margin-top:1rem;">Your secondary contact number has also been included for our team.</p>' : '';
  var orderSelection = '';
  if (products && products.length > 0) {
    orderSelection =
      '<div style="margin-top:2.5rem;"><h2 class="form-section-title">Your Selection</h2>' +
      buildOrderSummaryItems(products) +
      '<div class="confirmation-details" style="margin-top:1.5rem;">' +
        '<div class="confirmation-row"><span>Shipping</span><span>To be confirmed by our team</span></div>' +
        '<div class="confirmation-row"><span>Payment</span><span>To be arranged with Med Doorshipp</span></div>' +
      '</div></div>';
  }
  var html = renderPage('confirmation.html', req, {});
  html = html.replace('<!-- REQUEST_NUMBER -->', escapeHtml(buildRequestNumber(leadId)));
  html = html.replace('<!-- CONFIRM_EMAIL -->', escapeHtml(orderData.email));
  html = html.replace('<!-- CONFIRM_PHONE -->', maskPhone(orderData.contact_number));
  html = html.replace('<!-- SECONDARY_PHONE_NOTE -->', secondaryNote);
  html = html.replace('<!-- ORDER_SELECTION -->', orderSelection);
  return html;
}

app.post('/submit-order', function (req, res) {
  var body = req.body;
  if (body.terms_accepted !== 'on') {
    return res.status(400).send(renderLayout(
      '<main class="page-centered section-padding"><div class="container-shell success-card error-card"><h1>Terms Required</h1><p>Please accept the terms to continue.</p><a href="/checkout" class="btn-primary">Return to Checkout</a></div></main>',
      req
    ));
  }
  var validation = validateCheckout(body);
  if (!validation.ok) {
    return loadCartProducts(req, function (err, cartProducts) {
      if (err) return res.status(500).send('Database error');
      res.status(400).type('html').send(renderCheckoutPage(req, cartProducts, body, validation.errors));
    });
  }
  loadCartProducts(req, function (err, cartProducts) {
    var product_id = body.product_id || (cartProducts[0] ? cartProducts[0].id : null);
    var cart_snapshot = JSON.stringify(cartProducts.map(function (p) {
      var quote = getPackQuote(productOriginal(p), productSale(p), p.packSize || DEFAULT_PACK);
      return {
        id: p.id,
        title: p.title,
        qty: p.cartQty,
        pack_size: quote.packSize,
        original_price_usd: quote.original,
        price_usd: quote.discounted,
        currency: 'USD'
      };
    }));
    var billing_street = body.billing_street, billing_city = body.billing_city;
    var billing_state = body.billing_state, billing_postal = body.billing_postal;
    if (body.billing_same_as_shipping === 'on') {
      billing_street = body.shipping_street; billing_city = body.shipping_city;
      billing_state = body.shipping_state; billing_postal = body.shipping_postal;
    }
    db.run(
      'INSERT INTO leads (selected_product_id, first_name, last_name, email, contact_number, secondary_phone, ' +
      'shipping_street, shipping_line2, shipping_city, shipping_state, shipping_postal, shipping_country, ' +
      'billing_first_name, billing_last_name, billing_street, billing_line2, billing_city, billing_state, billing_postal, billing_country, ' +
      'shipping_method, order_notes, marketing_consent, terms_accepted, cart_snapshot, contact_handle, destination_country) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        product_id, body.first_name, body.last_name, body.email, body.contact_number, body.secondary_phone || '',
        body.shipping_street, body.shipping_line2 || '', body.shipping_city, body.shipping_state, body.shipping_postal,
        body.shipping_country || 'United States',
        body.billing_first_name || body.first_name, body.billing_last_name || body.last_name,
        billing_street, body.billing_line2 || '', billing_city, billing_state, billing_postal,
        body.shipping_country || 'United States',
        body.shipping_method || 'standard', body.order_notes || '',
        body.marketing_consent === 'on' ? 1 : 0, 1, cart_snapshot,
        body.email, body.shipping_country || 'United States'
      ],
      function (insertErr) {
        if (insertErr) {
          return res.status(500).send(renderLayout(
            '<main class="page-centered section-padding"><div class="container-shell success-card error-card"><h1>Request Unsuccessful</h1><a href="/checkout" class="btn-primary">Return to Checkout</a></div></main>', req
          ));
        }
        req.session.cart = [];
        res.send(buildConfirmationPage(req, this.lastID, {
          email: body.email, contact_number: body.contact_number, secondary_phone: body.secondary_phone
        }, cartProducts));
      }
    );
  });
});

['contact', 'privacy', 'refund-policy', 'terms', 'shipping', 'our-story'].forEach(function (slug) {
  app.get('/' + slug, function (req, res) {
    res.type('html').send(renderPage('pages/' + slug + '.html', req, {}));
  });
});

app.post('/contact', function (req, res) {
  res.type('html').send(renderPage('pages/contact.html', req, {})
    .replace('</main>', '<div class="notice-success container-shell"><p>Thank you, ' + escapeHtml(req.body.name) + '. Our pharmacy team will respond within one business day.</p></div></main>'));
});

app.get('/admin-login', function (req, res) {
  if (req.session.isAdmin) return res.redirect('/admin-dashboard');
  res.type('html').send(renderPage('login.html', req, {}));
});

app.post('/admin-login', function (req, res) {
  if (req.body.username === ADMIN_USERNAME && req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin-dashboard');
  }
  res.status(401).send(renderLayout(
    '<main class="page-centered section-padding"><div class="container-shell success-card error-card"><h1>Access Denied</h1><a href="/admin-login">Return</a></div></main>', req
  ));
});

var ORDER_STATUS_LABELS = {
  pending: 'Pending',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled'
};

function buildOrderStatusOptions(selected) {
  return ORDER_STATUSES.map(function (s) {
    var sel = s === (selected || 'pending') ? ' selected' : '';
    return '<option value="' + s + '"' + sel + '>' + ORDER_STATUS_LABELS[s] + '</option>';
  }).join('');
}

function buildAdminOrdersHtml(leads) {
  if (!leads || leads.length === 0) return '<p class="admin-empty">No orders recorded yet.</p>';
  return leads.map(function (lead) {
    var name = ((lead.first_name || '') + ' ' + (lead.last_name || '')).trim() || lead.email || '—';
    var status = lead.status || 'pending';
    return (
      '<article class="admin-order-card">' +
        '<div class="admin-order-head">' +
          '<span class="admin-order-id">' + buildRequestNumber(lead.id) + '</span>' +
          '<span class="order-status-badge order-status-' + escapeHtml(status) + '">' + escapeHtml(ORDER_STATUS_LABELS[status] || status) + '</span>' +
        '</div>' +
        '<div class="admin-order-body">' +
          '<p><span class="admin-order-field-label">Customer:</span> ' + escapeHtml(name) + '</p>' +
          '<p><span class="admin-order-field-label">Placed:</span> ' + escapeHtml(lead.timestamp) + '</p>' +
          '<p><span class="admin-order-field-label">Contact:</span> ' + escapeHtml(lead.email) + ' · ' + escapeHtml(lead.contact_number) + '</p>' +
          '<p><span class="admin-order-field-label">Ship to:</span> ' + escapeHtml(lead.shipping_street) + ', ' + escapeHtml(lead.shipping_city) + ', ' + escapeHtml(lead.shipping_state) + ' ' + escapeHtml(lead.shipping_postal) + ', ' + escapeHtml(lead.shipping_country) + '</p>' +
          '<p><span class="admin-order-field-label">Item:</span> ' + escapeHtml(lead.product_title || 'Multiple items') + (lead.product_price ? ' · ' + formatPriceUsd(lead.product_price) : '') + '</p>' +
        '</div>' +
        '<form action="/admin/orders/' + lead.id + '/update" method="POST" class="admin-order-update-form">' +
          '<label>Status<select name="status">' + buildOrderStatusOptions(status) + '</select></label>' +
          '<label>Tracking Number<input type="text" name="tracking_number" value="' + escapeHtml(lead.tracking_number || '') + '" placeholder="e.g. 1Z999AA10123456784"></label>' +
          '<label>Carrier<input type="text" name="carrier" value="' + escapeHtml(lead.carrier || '') + '" placeholder="e.g. UPS, FedEx"></label>' +
          '<button type="submit" class="btn-primary btn-sm">Save</button>' +
        '</form>' +
      '</article>'
    );
  }).join('');
}

function buildAdminProductsHtml(products) {
  if (!products || products.length === 0) return '<p class="admin-empty">No products yet — add one above.</p>';
  return (
    '<table class="admin-table admin-products-table">' +
      '<thead><tr><th>Image</th><th>Title</th><th>Category</th><th>Price</th><th>Stock</th><th>Actions</th></tr></thead>' +
      '<tbody>' +
      products.map(function (p) {
        var src = productImageSrc(p);
        var img = src ? '<img src="' + escapeHtml(src) + '" alt="" class="admin-thumb">' : '<div class="admin-thumb admin-thumb-empty"></div>';
        var stock = stockValue(p);
        return (
          '<tr>' +
            '<td>' + img + '</td>' +
            '<td>' + escapeHtml(p.title) + '</td>' +
            '<td>' + escapeHtml(p.category || '') + '</td>' +
            '<td>' + formatPriceUsd(p.price_usd) + '</td>' +
            '<td>' + (stock === null ? 'Not tracked' : stock) + '</td>' +
            '<td class="admin-row-actions">' +
              '<a href="/admin/products/' + p.id + '/edit" class="btn-secondary btn-sm">Edit</a>' +
              '<form action="/admin/products/' + p.id + '/delete" method="POST" class="inline-form" data-confirm="Delete this product? This cannot be undone.">' +
                '<button type="submit" class="btn-ghost btn-sm">Delete</button>' +
              '</form>' +
            '</td>' +
          '</tr>'
        );
      }).join('') +
      '</tbody></table>'
  );
}

app.get('/admin-dashboard', requireAdmin, function (req, res) {
  db.all(
    'SELECT leads.*, products.title AS product_title, products.price_usd AS product_price FROM leads LEFT JOIN products ON leads.selected_product_id = products.id ORDER BY leads.id DESC',
    [],
    function (err, leads) {
      if (err) return res.status(500).send('Database error');
      db.all('SELECT * FROM products ORDER BY id DESC', [], function (prodErr, products) {
        if (prodErr) return res.status(500).send('Database error');
        res.type('html').send(renderPage('admin.html', req, {
          LEADS_PLACEHOLDER: buildAdminOrdersHtml(leads),
          PRODUCTS_PLACEHOLDER: buildAdminProductsHtml(products)
        }));
      });
    }
  );
});

app.post('/admin/add-product', requireAdmin, upload.single('image'), function (req, res) {
  var original = req.body.original_price_usd;
  var discounted = req.body.price_usd;
  if (!original || parseFloat(original) < parseFloat(discounted)) {
    original = discounted;
  }
  var stockQty = req.body.stock_quantity === '' || req.body.stock_quantity === undefined
    ? null
    : parseInt(req.body.stock_quantity, 10);
  db.run(
    'INSERT INTO products (title, price_usd, original_price_usd, description, dosage_strength, precautions, image, category, stock_quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [
      req.body.title,
      discounted,
      original,
      req.body.description,
      req.body.dosage_strength,
      req.body.precautions,
      req.file ? req.file.filename : null,
      req.body.category || 'prescription',
      isNaN(stockQty) ? null : stockQty
    ],
    function (err) { res.redirect(err ? '/admin-dashboard' : '/admin-dashboard'); }
  );
});

function buildAdminProductFormReplacements(p, body) {
  var data = body || p || {};
  return {
    PRODUCT_ID: p ? String(p.id) : '',
    VALUE_title: escapeHtml(data.title || ''),
    VALUE_original_price_usd: escapeHtml(String(data.original_price_usd || '')),
    VALUE_price_usd: escapeHtml(String(data.price_usd || '')),
    VALUE_dosage_strength: escapeHtml(data.dosage_strength || ''),
    VALUE_description: escapeHtml(data.description || ''),
    VALUE_precautions: escapeHtml(data.precautions || ''),
    VALUE_stock_quantity: data.stock_quantity === null || data.stock_quantity === undefined ? '' : escapeHtml(String(data.stock_quantity)),
    SELECTED_prescription: (data.category || 'prescription') === 'prescription' ? ' selected' : '',
    SELECTED_wellness: data.category === 'wellness' ? ' selected' : '',
    'SELECTED_pain-relief': data.category === 'pain-relief' ? ' selected' : '',
    CURRENT_IMAGE: p && p.image ? '<img src="' + escapeHtml(productImageSrc(p)) + '" alt="" class="admin-current-image">' : '<p class="admin-help">No image set yet.</p>'
  };
}

app.get('/admin/products/:id/edit', requireAdmin, function (req, res) {
  db.get('SELECT * FROM products WHERE id = ?', [req.params.id], function (err, p) {
    if (err || !p) return res.redirect('/admin-dashboard');
    res.type('html').send(renderPage('admin-edit-product.html', req, buildAdminProductFormReplacements(p, null)));
  });
});

app.post('/admin/products/:id/edit', requireAdmin, upload.single('image'), function (req, res) {
  db.get('SELECT * FROM products WHERE id = ?', [req.params.id], function (err, existing) {
    if (err || !existing) return res.redirect('/admin-dashboard');
    var original = req.body.original_price_usd;
    var discounted = req.body.price_usd;
    if (!original || parseFloat(original) < parseFloat(discounted)) original = discounted;
    var image = req.file ? req.file.filename : existing.image;
    var stockQty = req.body.stock_quantity === '' || req.body.stock_quantity === undefined
      ? null
      : parseInt(req.body.stock_quantity, 10);
    db.run(
      'UPDATE products SET title=?, price_usd=?, original_price_usd=?, description=?, dosage_strength=?, precautions=?, image=?, category=?, stock_quantity=? WHERE id=?',
      [
        req.body.title, discounted, original, req.body.description, req.body.dosage_strength,
        req.body.precautions, image, req.body.category || 'prescription',
        isNaN(stockQty) ? null : stockQty, req.params.id
      ],
      function () { res.redirect('/admin-dashboard'); }
    );
  });
});

app.post('/admin/products/:id/delete', requireAdmin, function (req, res) {
  db.run('DELETE FROM products WHERE id = ?', [req.params.id], function () {
    res.redirect('/admin-dashboard');
  });
});

app.post('/admin/orders/:id/update', requireAdmin, function (req, res) {
  var status = ORDER_STATUSES.indexOf(req.body.status) !== -1 ? req.body.status : 'pending';
  db.run(
    'UPDATE leads SET status = ?, tracking_number = ?, carrier = ?, status_updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status, (req.body.tracking_number || '').trim(), (req.body.carrier || '').trim(), req.params.id],
    function () { res.redirect('/admin-dashboard'); }
  );
});

app.get('/admin-logout', function (req, res) {
  req.session.destroy(function () { res.redirect('/admin-login'); });
});

function buildTrackResultHtml(lead) {
  var status = lead.status || 'pending';
  var steps = ['pending', 'processing', 'shipped', 'delivered'];
  var currentIndex = steps.indexOf(status);
  var timeline = steps.map(function (step, i) {
    var cls = 'track-step';
    if (status === 'cancelled') cls += '';
    else if (i < currentIndex) cls += ' track-step-done';
    else if (i === currentIndex) cls += ' track-step-current';
    return '<li class="' + cls + '">' + ORDER_STATUS_LABELS[step] + '</li>';
  }).join('');
  var cancelledNote = status === 'cancelled' ? '<p class="track-cancelled-note">This order has been cancelled.</p>' : '';
  var trackingBlock = lead.tracking_number
    ? '<p class="track-tracking-number"><strong>Tracking Number:</strong> ' + escapeHtml(lead.tracking_number) + (lead.carrier ? ' (' + escapeHtml(lead.carrier) + ')' : '') + '</p>'
    : '<p class="track-tracking-number">Tracking number will appear here once your order ships.</p>';
  return (
    '<div class="track-result">' +
      '<h2>Order ' + escapeHtml(buildRequestNumber(lead.id)) + '</h2>' +
      cancelledNote +
      '<ol class="track-timeline">' + timeline + '</ol>' +
      trackingBlock +
      '<p class="track-updated">Last updated: ' + escapeHtml(lead.status_updated_at || lead.timestamp) + '</p>' +
    '</div>'
  );
}

app.post('/track', function (req, res) {
  var orderNumber = (req.body.order_number || '').trim();
  var email = (req.body.email || '').trim();
  var idMatch = orderNumber.match(/(\d+)\s*$/);
  var leadId = idMatch ? parseInt(idMatch[1], 10) : null;
  var notFoundHtml = '<div class="track-result track-not-found"><p>We couldn\'t find an order matching that Order Number and Email. Please double-check and try again.</p></div>';
  if (!leadId || !email) {
    return res.type('html').send(renderPage('track.html', req, {
      TRACK_RESULT: notFoundHtml,
      VALUE_order_number: escapeHtml(orderNumber),
      VALUE_email: escapeHtml(email)
    }));
  }
  db.get('SELECT * FROM leads WHERE id = ?', [leadId], function (err, lead) {
    var match = !err && lead && String(lead.email || '').toLowerCase() === email.toLowerCase();
    res.type('html').send(renderPage('track.html', req, {
      TRACK_RESULT: match ? buildTrackResultHtml(lead) : notFoundHtml,
      VALUE_order_number: escapeHtml(orderNumber),
      VALUE_email: escapeHtml(email)
    }));
  });
});

app.get('/track', function (req, res) {
  res.type('html').send(renderPage('track.html', req, {
    TRACK_RESULT: '',
    VALUE_order_number: '',
    VALUE_email: ''
  }));
});

app.use(function (err, req, res, next) {
  if (err && (err.message === 'INVALID_FILE_TYPE' || err.code === 'LIMIT_FILE_SIZE')) {
    var message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Image must be smaller than 5MB.'
      : 'Only JPG, PNG, WEBP, GIF, or SVG images are allowed.';
    return res.status(400).send(renderLayout(
      '<main class="page-centered section-padding"><div class="container-shell success-card error-card"><h1>Upload Error</h1><p>' + escapeHtml(message) + '</p><a href="/admin-dashboard" class="btn-primary">Back to Dashboard</a></div></main>',
      req
    ));
  }
  console.error(err);
  res.status(500).send('Server error');
});

app.listen(PORT, HOST, function () {
  console.log('Med Doorshipp portal listening on http://' + HOST + ':' + PORT + ' (loopback only — Tor-safe)');
});
