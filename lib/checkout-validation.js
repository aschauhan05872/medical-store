const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[\d\s().+\-]{7,30}$/;
const ZIP_RE = /^\d{5}(-\d{4})?$/;
const STREET_RE = /^\d+\s+[A-Za-z0-9\s.,#'\-]{2,}$/;

function digitsOnly(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function validateCheckout(body) {
  var errors = {};

  if (!body.email || !EMAIL_RE.test(String(body.email).trim())) {
    errors.email = 'Please enter a valid email address (e.g. you@example.com).';
  }

  if (!body.contact_number || !PHONE_RE.test(String(body.contact_number).trim())) {
    errors.contact_number = 'Please enter a valid phone number.';
  } else if (digitsOnly(body.contact_number).length < 10) {
    errors.contact_number = 'Phone number must contain at least 10 digits.';
  }

  if (body.secondary_phone && String(body.secondary_phone).trim()) {
    if (!PHONE_RE.test(String(body.secondary_phone).trim()) || digitsOnly(body.secondary_phone).length < 10) {
      errors.secondary_phone = 'Please enter a valid secondary phone number.';
    }
  }

  if (!body.first_name || String(body.first_name).trim().length < 2) {
    errors.first_name = 'First name is required (at least 2 characters).';
  }

  if (!body.last_name || String(body.last_name).trim().length < 2) {
    errors.last_name = 'Last name is required (at least 2 characters).';
  }

  var street = String(body.shipping_street || '').trim();
  if (!street || street.length < 5) {
    errors.shipping_street = 'Street address is required (at least 5 characters).';
  } else if (!STREET_RE.test(street)) {
    errors.shipping_street = 'Enter a valid street address starting with a number (e.g. 123 Main Street).';
  }

  if (!body.shipping_city || String(body.shipping_city).trim().length < 2) {
    errors.shipping_city = 'City is required.';
  }

  if (!body.shipping_state || !String(body.shipping_state).trim()) {
    errors.shipping_state = 'Please select a state.';
  }

  if (!body.shipping_postal || !ZIP_RE.test(String(body.shipping_postal).trim())) {
    errors.shipping_postal = 'Please enter a valid ZIP code (e.g. 02108).';
  }

  if (body.billing_same_as_shipping !== 'on') {
    var billingStreet = String(body.billing_street || '').trim();
    if (!billingStreet || billingStreet.length < 5 || !STREET_RE.test(billingStreet)) {
      errors.billing_street = 'Enter a valid billing street address starting with a number.';
    }
    if (!body.billing_city || String(body.billing_city).trim().length < 2) {
      errors.billing_city = 'Billing city is required.';
    }
    if (!body.billing_state) {
      errors.billing_state = 'Please select a billing state.';
    }
    if (!body.billing_postal || !ZIP_RE.test(String(body.billing_postal).trim())) {
      errors.billing_postal = 'Please enter a valid billing ZIP code.';
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors: errors
  };
}

module.exports = { validateCheckout, EMAIL_RE, PHONE_RE, ZIP_RE, STREET_RE };
