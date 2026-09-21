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

  document.addEventListener('submit', function (e) {
    if (e.defaultPrevented) return;
    var form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    var confirmMsg = form.getAttribute('data-confirm');
    if (confirmMsg && !window.confirm(confirmMsg)) {
      e.preventDefault();
      return;
    }
    if (form.hasAttribute('data-no-processing')) return;
    startProcessing(form);
  });
})();
