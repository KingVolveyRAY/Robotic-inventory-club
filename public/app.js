const siteHeader = document.querySelector('[data-site-header]');
if (siteHeader) {
  siteHeader.setAttribute('data-scroll-ready', '');
  let framePending = false;
  function updateHeader() {
    framePending = false;
    const threshold = siteHeader.hasAttribute('data-compact') ? 55 : 110;
    siteHeader.toggleAttribute('data-compact', window.scrollY > threshold);
  }

  window.addEventListener('scroll', () => {
    if (framePending) return;
    framePending = true;
    window.requestAnimationFrame(updateHeader);
  }, { passive: true });
  window.addEventListener('pageshow', updateHeader);

  function showTooltipsAgain() {
    siteHeader.removeAttribute('data-tooltip-dismissed');
  }

  siteHeader.addEventListener('focusin', showTooltipsAgain);
  siteHeader.addEventListener('pointerover', showTooltipsAgain);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && siteHeader.hasAttribute('data-compact')) {
      siteHeader.setAttribute('data-tooltip-dismissed', '');
    }
  });

  updateHeader();
}

for (const select of document.querySelectorAll('[data-submit-on-change]')) {
  select.addEventListener('change', () => select.form.requestSubmit());
}

const loanForm = document.querySelector('[data-loan-days]');
if (loanForm) {
  const start = loanForm.elements.start;
  const due = loanForm.elements.due;
  const days = Number(loanForm.dataset.loanDays);
  function syncDates() {
    if (!start.value) return;
    const lastDue = new Date(start.value + 'T00:00:00Z');
    lastDue.setUTCDate(lastDue.getUTCDate() + days - 1);
    due.min = start.value;
    due.max = lastDue.toISOString().slice(0, 10);
  }
  start.addEventListener('change', () => {
    syncDates();
    if (due.value < due.min || due.value > due.max) due.value = start.value;
  });
  syncDates();
}

for (const button of document.querySelectorAll('[data-demo-login]')) {
  button.hidden = false;
  button.addEventListener('click', () => {
    const form = document.getElementById('auth-form');
    form.elements.login.value = button.dataset.demoLogin;
    form.elements.password.value = button.dataset.demoPassword;
    form.querySelector('button[type="submit"]').focus();
  });
}

const accountMenu = document.querySelector('.account-menu');
if (accountMenu) {
  document.addEventListener('click', (event) => {
    if (!accountMenu.contains(event.target)) accountMenu.open = false;
  });
  accountMenu.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      accountMenu.open = false;
      accountMenu.querySelector('summary').focus();
    }
  });
}

let activeSubmission;

document.addEventListener('submit', (event) => {
  if (event.defaultPrevented) return;
  if (activeSubmission) {
    event.preventDefault();
    return;
  }

  const button = event.submitter;
  const message = button?.dataset.confirm;
  if (message && !window.confirm(message)) {
    event.preventDefault();
    return;
  }

  const label = event.target.dataset.busyLabel;
  if (!label || !(button instanceof HTMLButtonElement)) return;

  activeSubmission = { button, content: Array.from(button.childNodes) };
  const spinner = document.createElement('span');
  spinner.className = 'button-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  button.replaceChildren(spinner, document.createTextNode(label));
  // Keep the submitter enabled so its name and value are included in the request.
  button.setAttribute('aria-busy', 'true');
  button.setAttribute('aria-disabled', 'true');
});

window.addEventListener('pageshow', () => {
  if (!activeSubmission) return;
  const { button, content } = activeSubmission;
  button.replaceChildren(...content);
  button.removeAttribute('aria-busy');
  button.removeAttribute('aria-disabled');
  activeSubmission = undefined;
});

const addPart = document.querySelector('[data-add-kit-part]');
if (addPart) {
  const parts = [...document.querySelectorAll('[data-kit-part]')];
  const shown = Math.max(2, parts.findLastIndex((part) => part.querySelector('select').value) + 1);
  parts.forEach((part, index) => { part.hidden = index >= shown; });
  addPart.hidden = shown === parts.length;
  addPart.addEventListener('click', () => {
    const next = parts.find((part) => part.hidden);
    if (!next) return;
    next.hidden = false;
    next.querySelector('select').focus();
    addPart.hidden = parts.every((part) => !part.hidden);
  });
}

for (const button of document.querySelectorAll('[data-print-label]')) {
  button.hidden = false;
  button.addEventListener('click', () => window.print());
}
