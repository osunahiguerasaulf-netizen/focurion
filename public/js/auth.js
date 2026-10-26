const tabs = document.querySelectorAll('[data-auth-tab]');
const authTabs = document.querySelector('.auth-tabs');
const forms = {
  login: document.querySelector('#loginForm'),
  register: document.querySelector('#registerForm'),
  forgot: document.querySelector('#forgotForm'),
  reset: document.querySelector('#resetForm')
};
const message = document.querySelector('#authMessage');

function setMessage(text = '', type = '') {
  message.textContent = text;
  message.className = `form-message${type ? ` ${type}` : ''}`;
}

function setAuthView(view) {
  const isMain = view === 'login' || view === 'register';
  authTabs.classList.toggle('hidden', !isMain);
  tabs.forEach(button => button.classList.toggle('active', button.dataset.authTab === view));
  Object.entries(forms).forEach(([name, form]) => form.classList.toggle('active', name === view));
  setMessage();
  forms[view]?.querySelector('input:not([type="hidden"])')?.focus();
}

tabs.forEach(button => button.addEventListener('click', () => setAuthView(button.dataset.authTab)));
document.querySelector('#forgotPasswordLink').addEventListener('click', () => {
  forms.forgot.elements.email.value = forms.login.elements.email.value;
  setAuthView('forgot');
});
document.querySelector('#backToLogin').addEventListener('click', () => setAuthView('login'));
document.querySelector('#backFromReset').addEventListener('click', () => setAuthView('forgot'));

document.querySelectorAll('.toggle-password').forEach(button => {
  button.addEventListener('click', () => {
    const input = button.parentElement.querySelector('input');
    input.type = input.type === 'password' ? 'text' : 'password';
    button.innerHTML = FocurionIcons.svg(input.type === 'password' ? 'eye' : 'eyeOff');
    button.setAttribute('aria-label', input.type === 'password' ? 'Mostrar contraseña' : 'Ocultar contraseña');
  });
});

async function request(endpoint, payload) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'No fue posible continuar.');
  return data;
}

async function withPending(form, work) {
  const submit = form.querySelector('button[type="submit"]');
  const original = submit.textContent;
  submit.disabled = true;
  submit.textContent = 'Procesando…';
  setMessage();
  try { return await work(); }
  catch (error) { setMessage(error.message, 'error'); throw error; }
  finally { submit.disabled = false; submit.textContent = original; }
}

async function submitAuth(endpoint, form) {
  await withPending(form, async () => {
    const data = await request(endpoint, Object.fromEntries(new FormData(form).entries()));
    setMessage('Acceso correcto. Abriendo Focurion…', 'success');
    window.location.href = data.user?.role === 'admin' ? '/app#admin' : '/app';
  }).catch(() => {});
}

forms.login.addEventListener('submit', event => {
  event.preventDefault();
  submitAuth('/api/auth/login', forms.login);
});

forms.register.addEventListener('submit', event => {
  event.preventDefault();
  submitAuth('/api/auth/register', forms.register);
});

forms.forgot.addEventListener('submit', event => {
  event.preventDefault();
  withPending(forms.forgot, async () => {
    const email = forms.forgot.elements.email.value.trim().toLowerCase();
    const data = await request('/api/auth/forgot-password', { email });
    forms.reset.elements.email.value = email;
    document.querySelector('#resetEmailHint').textContent = `Escribe el código enviado a ${email}.`;
    const devBox = document.querySelector('#developmentCode');
    if (data.developmentCode) {
      devBox.innerHTML = `<strong>Modo local XAMPP</strong><span>Tu código es <b>${data.developmentCode}</b></span><small>Al configurar SMTP, el código llegará por correo.</small>`;
      devBox.classList.remove('hidden');
      forms.reset.elements.code.value = data.developmentCode;
    } else devBox.classList.add('hidden');
    setAuthView('reset');
    setMessage(data.message, 'success');
  }).catch(() => {});
});

forms.reset.addEventListener('submit', event => {
  event.preventDefault();
  withPending(forms.reset, async () => {
    const payload = Object.fromEntries(new FormData(forms.reset).entries());
    if (payload.newPassword !== payload.confirmPassword) throw new Error('Las contraseñas no coinciden.');
    const data = await request('/api/auth/reset-password', {
      email: payload.email,
      code: payload.code,
      newPassword: payload.newPassword
    });
    forms.login.elements.email.value = payload.email;
    forms.login.elements.password.value = '';
    forms.reset.reset();
    setAuthView('login');
    setMessage(data.message, 'success');
  }).catch(() => {});
});

fetch('/api/me')
  .then(async response => {
    if (!response.ok) return;
    const data = await response.json();
    window.location.href = data.user?.role === 'admin' ? '/app#admin' : '/app';
  })
  .catch(() => {});
