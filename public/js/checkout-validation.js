(function () {
  var form = document.getElementById('checkout-form');
  if (!form) return;

  form.querySelectorAll('.field-error').forEach(function (el) {
    if (el.textContent.trim()) el.hidden = false;
  });
  var serverBanner = document.getElementById('checkout-form-error');
  if (serverBanner && serverBanner.textContent.trim()) serverBanner.hidden = false;

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var PHONE_RE = /^[\d\s().+\-]{7,30}$/;
  var ZIP_RE = /^\d{5}(-\d{4})?$/;
  var STREET_RE = /^\d+\s+[A-Za-z0-9\s.,#'\-]{2,}$/;

  function digitsOnly(v) {
    return String(v || '').replace(/\D/g, '');
  }

  function showError(fieldId, message) {
    var input = document.getElementById(fieldId);
    var err = document.getElementById(fieldId + '_error');
    if (input) input.classList.add('input-invalid');
    if (err) {
      err.textContent = message;
      err.hidden = false;
    }
  }

  function clearError(fieldId) {
    var input = document.getElementById(fieldId);
    var err = document.getElementById(fieldId + '_error');
    if (input) input.classList.remove('input-invalid');
    if (err) {
      err.textContent = '';
      err.hidden = true;
    }
  }

  function clearAllErrors() {
    form.querySelectorAll('.field-error').forEach(function (el) {
      el.textContent = '';
      el.hidden = true;
    });
    form.querySelectorAll('.input-invalid').forEach(function (el) {
      el.classList.remove('input-invalid');
    });
    var banner = document.getElementById('checkout-form-error');
    if (banner) banner.hidden = true;
  }

  function validateField(fieldId) {
    var el = document.getElementById(fieldId);
    if (!el) return true;
    var v = el.value.trim();

    if (fieldId === 'email') {
      if (!EMAIL_RE.test(v)) {
        showError(fieldId, 'Please enter a valid email address (e.g. you@example.com).');
        return false;
      }
    } else if (fieldId === 'contact_number') {
      if (!PHONE_RE.test(v) || digitsOnly(v).length < 10) {
        showError(fieldId, 'Please enter a valid phone number with at least 10 digits.');
        return false;
      }
    } else if (fieldId === 'secondary_phone') {
      if (v && (!PHONE_RE.test(v) || digitsOnly(v).length < 10)) {
        showError(fieldId, 'Please enter a valid secondary phone number.');
        return false;
      }
    } else if (fieldId === 'shipping_street' || fieldId === 'billing_street') {
      if (!v || v.length < 5 || !STREET_RE.test(v)) {
        showError(fieldId, 'Enter a valid street address starting with a number (e.g. 123 Main Street).');
        return false;
      }
    } else if (fieldId === 'shipping_city' || fieldId === 'billing_city') {
      if (v.length < 2) {
        showError(fieldId, 'City is required.');
        return false;
      }
    } else if (fieldId === 'shipping_postal' || fieldId === 'billing_postal') {
      if (!ZIP_RE.test(v)) {
        showError(fieldId, 'Please enter a valid ZIP code (e.g. 02108).');
        return false;
      }
    } else if (fieldId === 'shipping_state' || fieldId === 'billing_state') {
      if (!v) {
        showError(fieldId, 'Please select a state.');
        return false;
      }
    } else if (fieldId === 'first_name' || fieldId === 'last_name') {
      if (v.length < 2) {
        showError(fieldId, 'This field is required (at least 2 characters).');
        return false;
      }
    }

    clearError(fieldId);
    return true;
  }

  function autofillFromCity(cityId, stateId, zipId, hintId) {
    var cityEl = document.getElementById(cityId);
    var stateEl = document.getElementById(stateId);
    var zipEl = document.getElementById(zipId);
    var hintEl = document.getElementById(hintId);
    if (!cityEl || !stateEl || !zipEl) return;

    var key = cityEl.value.trim().toLowerCase();
    var lookup = window.MED_CITY_LOOKUP || {};
    var match = lookup[key];

    if (match) {
      stateEl.value = match.state;
      zipEl.value = match.zip;
      clearError(stateId);
      clearError(zipId);
      clearError(cityId);
      if (hintEl) {
        hintEl.textContent = 'State and ZIP suggested for ' + cityEl.value.trim() + ' — you may edit them below.';
        hintEl.hidden = false;
      }
    } else if (hintEl) {
      hintEl.hidden = true;
    }
  }

  function setupCityAutofill(cityId, stateId, zipId, hintId) {
    var cityEl = document.getElementById(cityId);
    if (!cityEl) return;
    cityEl.addEventListener('blur', function () {
      autofillFromCity(cityId, stateId, zipId, hintId);
    });
    cityEl.addEventListener('change', function () {
      autofillFromCity(cityId, stateId, zipId, hintId);
    });
  }

  setupCityAutofill('shipping_city', 'shipping_state', 'shipping_postal', 'shipping_city_hint');
  setupCityAutofill('billing_city', 'billing_state', 'billing_postal', 'billing_city_hint');

  var watched = [
    'email', 'contact_number', 'secondary_phone', 'first_name', 'last_name',
    'shipping_street', 'shipping_city', 'shipping_state', 'shipping_postal',
    'billing_street', 'billing_city', 'billing_state', 'billing_postal'
  ];

  watched.forEach(function (id) {
    var el = document.getElementById(id);
    if (el) {
      el.addEventListener('blur', function () { validateField(id); });
      el.addEventListener('input', function () { clearError(id); });
    }
  });

  form.addEventListener('submit', function (e) {
    clearAllErrors();
    var required = [
      'email', 'contact_number', 'first_name', 'last_name',
      'shipping_street', 'shipping_city', 'shipping_state', 'shipping_postal'
    ];
    var billingVisible = !document.getElementById('billing_same_as_shipping').checked;
    if (billingVisible) {
      required = required.concat(['billing_street', 'billing_city', 'billing_state', 'billing_postal']);
    }

    var valid = true;
    required.forEach(function (id) {
      if (!validateField(id)) valid = false;
    });
    validateField('secondary_phone');

    if (!valid) {
      e.preventDefault();
      var banner = document.getElementById('checkout-form-error');
      if (banner) {
        banner.hidden = false;
        banner.textContent = 'Please correct the highlighted fields before submitting.';
      }
      var firstInvalid = form.querySelector('.input-invalid');
      if (firstInvalid) firstInvalid.focus();
    }
  });
})();
