(function () {
  var NAV_BLOCK_SELECTOR = '.cart-page-actions a, .cart-header-link, .checkout-page .back-link';

  function blockNavigation(e) {
    e.preventDefault();
  }

  function setButtonLoading(button, label) {
    if (!button || button.classList.contains('btn-loading')) return;
    button.dataset.originalText = button.textContent.trim();
    button.classList.add('btn-loading');
    button.setAttribute('aria-busy', 'true');
    button.textContent = label || button.dataset.processingLabel || 'Processing…';
  }

  function disableFormFields(form) {
    form.querySelectorAll('input, select, textarea, button').forEach(function (el) {
      if (el.type === 'hidden' || el.type === 'submit') return;
      el.disabled = true;
    });
  }

  function lockSubmittingForm(form) {
    form.classList.add('is-processing');
    var submitBtn = form.querySelector('[type="submit"]');
    if (submitBtn) setButtonLoading(submitBtn);
    form.querySelectorAll('input:not([type="hidden"]), select, textarea').forEach(function (el) {
      el.readOnly = true;
    });
  }

  function startProcessing(form) {
    document.body.classList.add('site-processing');
    lockSubmittingForm(form);

    document.querySelectorAll('.cart-qty-form, .cart-page-item form').forEach(function (otherForm) {
      if (otherForm === form) return;
      otherForm.classList.add('is-processing');
      disableFormFields(otherForm);
    });

    document.querySelectorAll(NAV_BLOCK_SELECTOR).forEach(function (link) {
      link.classList.add('is-disabled');
      link.setAttribute('aria-disabled', 'true');
      link.addEventListener('click', blockNavigation);
    });
  }

  function updateCartBadges(count) {
    document.querySelectorAll('.cart-badge').forEach(function (el) {
      el.textContent = String(count);
    });
  }

  function handleAjaxCartAdd(form) {
    var button = form.querySelector('[type="submit"]');
    var originalLabel = button ? button.textContent.trim() : '';
    var note = document.querySelector('[data-cart-note-for="' + (form.getAttribute('data-product-id') || '') + '"]');
    if (button) {
      button.disabled = true;
      button.textContent = button.dataset.processingLabel || 'Adding…';
    }
    fetch(form.getAttribute('action'), {
      method: 'POST',
      body: new FormData(form),
      headers: { 'X-Requested-With': 'fetch' },
      credentials: 'same-origin'
    })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (result) {
        if (!result.ok || !result.data || !result.data.ok) {
          var err = new Error('cart-add-failed');
          err.serverReason = result.data && result.data.error;
          throw err;
        }
        updateCartBadges(result.data.cartCount);
        if (button) {
          button.textContent = button.dataset.addedLabel || 'Added ✓';
          button.classList.add('btn-added');
        }
        if (note) {
          note.hidden = false;
          note.textContent = result.data.quantityInCart + ' in cart';
        }
        setTimeout(function () {
          if (button) {
            button.disabled = false;
            button.textContent = originalLabel;
            button.classList.remove('btn-added');
          }
        }, 1800);
      })
      .catch(function (err) {
        if (button) {
          button.disabled = false;
          button.textContent = 'Try Again';
        }
        if (note) {
          var reasonText = {
            not_found: 'This item is no longer available. Please refresh the page.',
            out_of_stock: 'This item just went out of stock.',
            db_error: 'A server error occurred — please try again in a moment.'
          }[err && err.serverReason] || 'Could not add to cart — please try again.';
          note.hidden = false;
          note.textContent = reasonText;
          note.classList.add('cart-qty-note-error');
        }
      });
  }

  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var confirmMsg = form.getAttribute('data-confirm');
    if (confirmMsg && !window.confirm(confirmMsg)) {
      e.preventDefault();
      return;
    }
    if (form.classList.contains('ajax-cart-form')) {
      e.preventDefault();
      handleAjaxCartAdd(form);
      return;
    }
    if (form.hasAttribute('data-no-processing')) return;
    startProcessing(form);
  });
})();
