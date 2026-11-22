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

for (const button of document.querySelectorAll('[data-demo-email]')) {
  button.hidden = false;
  button.addEventListener('click', () => {
    const form = document.getElementById('auth-form');
    form.elements.email.value = button.dataset.demoEmail;
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

document.addEventListener('submit', (event) => {
  const message = event.submitter?.dataset.confirm;
  if (message && !window.confirm(message)) event.preventDefault();
});
