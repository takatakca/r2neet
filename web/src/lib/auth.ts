interface ApiFailure {
  error?: {
    code?: string;
    message?: string;
    requestId?: string;
  };
}

class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

interface SendCodeResponse {
  sent: boolean;
  message: string;
  maskedPhone: string;
}

interface VerifyCodeResponse {
  outcome: 'AUTHENTICATED' | 'PROFILE_REQUIRED';
  intent: AuthIntent;
}

type AuthPage = 'login' | 'verify' | 'signup';
type AuthIntent = 'login' | 'signup';

const page = document.body.dataset.authPage as AuthPage | undefined;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (!found) {
    throw new Error(`Missing required element: #${id}`);
  }

  return found as T;
}

function showError(message: string): void {
  const error = document.getElementById('error');

  if (!error) return;

  error.textContent = message;
  error.hidden = message.length === 0;
}

function storedIntent(): AuthIntent | null {
  const value = sessionStorage.getItem('r2nette.authIntent');

  if (value === 'login' || value === 'signup') return value;

  return null;
}

/** Customer copy only. Prisma codes, stacks, and provider dumps stay hidden. */
function isSafeCustomerMessage(message: string): boolean {
  if (message.length === 0 || message.length > 240) return false;
  if (/[\r\n]/.test(message)) return false;
  if (/\bP\d{4}\b/.test(message)) return false;
  if (
    /prisma|stack trace|node_modules|twilio|sqlstate|econn|etimedout|at\s+\S+\s+\(/i.test(
      message,
    )
  ) {
    return false;
  }

  return true;
}

function customerFacingMessage(
  status: number,
  backendMessage: string | undefined,
): string {
  if (backendMessage && isSafeCustomerMessage(backendMessage)) {
    return backendMessage;
  }

  if (status === 400) {
    return 'The information submitted is not valid. Check the highlighted fields and try again.';
  }

  if (status === 401) {
    return 'Your verified registration session expired. Please verify your number again.';
  }

  if (status === 404) {
    return 'No completed R2NETTE account was found for this phone number.';
  }

  if (status === 409) {
    return 'An R2NETTE account already exists for this phone number.';
  }

  if (status === 429) {
    return 'Too many verification attempts. Please wait before trying again.';
  }

  if (status >= 500) {
    return 'The verification service is temporarily unavailable. Please try again shortly.';
  }

  return 'The request could not be completed. Please try again.';
}

function safeReturnPath(): string {
  const parameters = new URLSearchParams(window.location.search);

  const requested =
    parameters.get('returnTo') ??
    sessionStorage.getItem('r2nette.returnTo') ??
    '/account';

  if (!requested.startsWith('/') || requested.startsWith('//')) {
    return '/account';
  }

  return requested;
}

async function apiRequest<T>(
  path: string,
  initialization: RequestInit = {},
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(path, {
      ...initialization,

      headers: {
        "Content-Type": "application/json",
        ...(initialization.headers ?? {}),
      },

      credentials: "same-origin",
    });
  } catch {
    throw new ApiRequestError(
      "NETWORK_ERROR",
      "We could not connect to R2NETTE. Check your internet connection and try again.",
      0,
    );
  }

  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown;

  if (contentType.includes("application/json")) {
    body = await response.json().catch(() => undefined);
  } else {
    body = await response.text().catch(() => undefined);
  }

  if (!response.ok) {
    const failure =
      typeof body === "object" && body !== null
        ? (body as ApiFailure)
        : undefined;

    const backendMessage = failure?.error?.message;
    const backendCode = failure?.error?.code;

    throw new ApiRequestError(
      backendCode ?? `HTTP_${response.status}`,
      customerFacingMessage(response.status, backendMessage),
      response.status,
    );
  }

  if (
    typeof body !== "object" ||
    body === null
  ) {
    throw new ApiRequestError(
      "INVALID_RESPONSE",
      "R2NETTE received an invalid response from the verification service.",
      response.status,
    );
  }

  return body as T;
}

function initializeLoginPage(): void {
  const form = element<HTMLFormElement>('phoneForm');
  const phoneInput = element<HTMLInputElement>('phone');
  const button = element<HTMLButtonElement>('submitButton');
  const label = element<HTMLSpanElement>('submitLabel');

  const loginToggle = element<HTMLButtonElement>('loginToggle');

  const signupToggle = element<HTMLButtonElement>('signupToggle');

  const authPanel = element<HTMLElement>('authPanel');

  const authTitle = element<HTMLElement>('authTitle');

  const authDescription = element<HTMLElement>('authDescription');

  const suggestedModeButton = element<HTMLButtonElement>('suggestedModeButton');

  const requestedMode = new URLSearchParams(window.location.search).get('mode');

  let intent: AuthIntent = requestedMode === 'signup' ? 'signup' : 'login';

  function copyForMode(mode: AuthIntent): {
    title: string;
    description: string;
    submit: string;
    sending: string;
    security: string;
    pageTitle: string;
  } {
    if (mode === 'signup') {
      return {
        title: 'Create your account',
        description: 'Enter your mobile number to begin your registration.',
        submit: 'Start registration',
        sending: 'Sending verification code…',
        security:
          'Your account is created only after registration is completed',
        pageTitle: 'Sign up — R2NETTE',
      };
    }

    return {
      title: 'Welcome back',
      description: 'Enter your mobile number to access your account.',
      submit: 'Send login code',
      sending: 'Sending login code…',
      security: 'Secure password-free sign in',
      pageTitle: 'Login — R2NETTE',
    };
  }

  function setMode(mode: AuthIntent): void {
    intent = mode;

    const loginActive = mode === 'login';
    const copy = copyForMode(mode);

    loginToggle.setAttribute('aria-selected', String(loginActive));

    signupToggle.setAttribute('aria-selected', String(!loginActive));

    loginToggle.tabIndex = loginActive ? 0 : -1;
    signupToggle.tabIndex = loginActive ? -1 : 0;

    authPanel.setAttribute(
      'aria-labelledby',
      loginActive ? 'loginToggle' : 'signupToggle',
    );

    authTitle.textContent = copy.title;
    authDescription.textContent = copy.description;
    label.textContent = copy.submit;
    document.title = copy.pageTitle;

    suggestedModeButton.hidden = true;
    showError('');

    const url = new URL(window.location.href);

    if (mode === 'signup') {
      url.searchParams.set('mode', 'signup');
    } else {
      url.searchParams.delete('mode');
    }

    window.history.replaceState(
      null,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }

  loginToggle.addEventListener('click', () => {
    setMode('login');
  });

  signupToggle.addEventListener('click', () => {
    setMode('signup');
  });

  loginToggle.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setMode('signup');
      signupToggle.focus();
    }
  });

  signupToggle.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      setMode('login');
      loginToggle.focus();
    }
  });

  suggestedModeButton.addEventListener('click', () => {
    const suggestedMode: AuthIntent = intent === 'login' ? 'signup' : 'login';

    setMode(suggestedMode);

    (suggestedMode === 'login' ? loginToggle : signupToggle).focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');
    suggestedModeButton.hidden = true;

    const phone = phoneInput.value.trim();

    if (!phone) {
      showError('Enter your mobile number.');
      phoneInput.focus();
      return;
    }

    const copy = copyForMode(intent);

    button.disabled = true;
    loginToggle.disabled = true;
    signupToggle.disabled = true;
    label.textContent = copy.sending;

    try {
      const result = await apiRequest<SendCodeResponse>(
        '/api/v1/auth/phone/send',
        {
          method: 'POST',
          body: JSON.stringify({
            phone,
            intent,
          }),
        },
      );

      sessionStorage.setItem('r2nette.authPhone', phone);

      sessionStorage.setItem('r2nette.authIntent', intent);

      sessionStorage.setItem('r2nette.maskedPhone', result.maskedPhone);

      sessionStorage.setItem('r2nette.returnTo', safeReturnPath());

      window.location.assign('/verify');
    } catch (error) {
      showError(
        error instanceof Error
          ? error.message
          : 'Unable to send the verification code.',
      );

      if (
        error instanceof ApiRequestError &&
        error.code === 'ACCOUNT_NOT_FOUND'
      ) {
        suggestedModeButton.textContent = 'Go to Sign up';

        suggestedModeButton.hidden = false;
      }

      if (
        error instanceof ApiRequestError &&
        error.code === 'ACCOUNT_ALREADY_EXISTS'
      ) {
        suggestedModeButton.textContent = 'Go to Login';

        suggestedModeButton.hidden = false;
      }
    } finally {
      button.disabled = false;
      loginToggle.disabled = false;
      signupToggle.disabled = false;

      label.textContent = copyForMode(intent).submit;
    }
  });

  setMode(intent);
}

function initializeVerifyPage(): void {
  const phone = sessionStorage.getItem('r2nette.authPhone');
  const intent = storedIntent();

  if (!phone || !intent) {
    window.location.replace('/login');
    return;
  }

  const maskedPhone = document.getElementById('maskedPhone');

  if (maskedPhone) {
    maskedPhone.textContent =
      sessionStorage.getItem('r2nette.maskedPhone') ?? phone;
  }

  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('[data-otp]'),
  );

  const verifyButton = element<HTMLButtonElement>('verifyButton');

  const resendButton = element<HTMLButtonElement>('resendButton');

  let verifying = false;
  let resendSeconds = 30;
  let resendTimer: number | undefined;

  function codeValue(): string {
    return inputs.map((input) => input.value).join('');
  }

  function setInputsDisabled(disabled: boolean): void {
    inputs.forEach((input) => {
      input.disabled = disabled;
    });
  }

  function clearInputs(): void {
    inputs.forEach((input) => {
      input.value = '';
    });

    inputs[0]?.focus();
  }

  async function verifyCode(): Promise<void> {
    const code = codeValue();

    if (code.length !== 6 || verifying) return;

    verifying = true;
    showError('');
    setInputsDisabled(true);

    verifyButton.disabled = true;
    verifyButton.textContent = 'Verifying…';

    try {
      const result = await apiRequest<VerifyCodeResponse>(
        '/api/v1/auth/phone/verify',
        {
          method: 'POST',
          body: JSON.stringify({
            phone,
            code,
            intent,
          }),
        },
      );

      sessionStorage.removeItem('r2nette.authPhone');
      sessionStorage.removeItem('r2nette.maskedPhone');
      sessionStorage.removeItem('r2nette.authIntent');

      const returnTo = safeReturnPath();

      if (result.outcome === 'AUTHENTICATED') {
        sessionStorage.removeItem('r2nette.returnTo');
        window.location.assign(returnTo);
        return;
      }

      if (result.outcome === 'PROFILE_REQUIRED') {
        window.location.assign(
          `/signup?returnTo=${encodeURIComponent(returnTo)}`,
        );
        return;
      }

      showError(
        'The verification service returned an unexpected result. Try again.',
      );
      setInputsDisabled(false);
      clearInputs();
    } catch (error) {
      showError(
        error instanceof Error
          ? error.message
          : 'That code was not accepted. Try again.',
      );

      setInputsDisabled(false);
      clearInputs();
    } finally {
      verifying = false;
      verifyButton.disabled = false;
      verifyButton.textContent = 'Verify code';
    }
  }

  inputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(-1);

      if (input.value) {
        inputs[index + 1]?.focus();
      }

      if (inputs.every((codeInput) => codeInput.value)) {
        void verifyCode();
      }
    });

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !input.value && index > 0) {
        inputs[index - 1]?.focus();
      }
    });

    input.addEventListener('paste', (event) => {
      const digits =
        event.clipboardData?.getData('text').replace(/\D/g, '').slice(0, 6) ??
        '';

      if (digits.length !== 6) return;

      event.preventDefault();

      inputs.forEach((codeInput, digitIndex) => {
        codeInput.value = digits[digitIndex] ?? '';
      });

      void verifyCode();
    });
  });

  verifyButton.addEventListener('click', () => {
    if (codeValue().length !== 6) {
      showError('Enter the complete 6-digit code.');
      return;
    }

    void verifyCode();
  });

  function startResendTimer(): void {
    window.clearInterval(resendTimer);

    resendSeconds = 30;
    resendButton.disabled = true;
    resendButton.textContent = `Resend code in 0:${String(
      resendSeconds,
    ).padStart(2, '0')}`;

    resendTimer = window.setInterval(() => {
      resendSeconds -= 1;

      if (resendSeconds <= 0) {
        window.clearInterval(resendTimer);
        resendButton.disabled = false;
        resendButton.textContent = 'Resend code';
        return;
      }

      resendButton.textContent = `Resend code in 0:${String(
        resendSeconds,
      ).padStart(2, '0')}`;
    }, 1000);
  }

  resendButton.addEventListener('click', async () => {
    showError('');
    resendButton.disabled = true;

    try {
      const result = await apiRequest<SendCodeResponse>(
        '/api/v1/auth/phone/send',
        {
          method: 'POST',
          body: JSON.stringify({ phone, intent }),
        },
      );

      sessionStorage.setItem('r2nette.maskedPhone', result.maskedPhone);

      if (maskedPhone) {
        maskedPhone.textContent = result.maskedPhone;
      }

      startResendTimer();
    } catch (error) {
      resendButton.disabled = false;

      showError(
        error instanceof Error ? error.message : 'Unable to resend the code.',
      );
    }
  });

  startResendTimer();
}

function initializeSignupPage(): void {
  const form = element<HTMLFormElement>('profileForm');
  const firstName = element<HTMLInputElement>('firstName');
  const lastName = element<HTMLInputElement>('lastName');
  const email = element<HTMLInputElement>('email');
  const consent = element<HTMLInputElement>('consent');
  const button = element<HTMLButtonElement>('submitButton');
  const label = element<HTMLSpanElement>('submitLabel');
  const localeEn = element<HTMLButtonElement>('localeEn');
  const localeFr = element<HTMLButtonElement>('localeFr');

  function setLocale(locale: 'en' | 'fr'): void {
    localeEn.setAttribute('aria-pressed', String(locale === 'en'));
    localeFr.setAttribute('aria-pressed', String(locale === 'fr'));
  }

  function currentLocale(): 'en' | 'fr' {
    return localeFr.getAttribute('aria-pressed') === 'true' ? 'fr' : 'en';
  }

  localeEn.addEventListener('click', () => {
    setLocale('en');
  });

  localeFr.addEventListener('click', () => {
    setLocale('fr');
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    showError('');

    const cleanFirstName = firstName.value.trim();
    const cleanLastName = lastName.value.trim();
    const cleanEmail = email.value.trim();

    if (!cleanFirstName) {
      showError('Enter your first name.');
      firstName.focus();
      return;
    }

    if (!cleanLastName) {
      showError('Enter your last name.');
      lastName.focus();
      return;
    }

    if (!/^\S+@\S+\.\S{2,}$/.test(cleanEmail)) {
      showError('Enter a valid email address.');
      email.focus();
      return;
    }

    button.disabled = true;
    label.textContent = 'Saving…';

    try {
      await apiRequest<{
        customer: {
          id: string;
          firstName: string | null;
          lastName: string | null;
          email: string | null;
        };
      }>('/api/v1/auth/registration/complete', {
        method: 'POST',

        body: JSON.stringify({
          firstName: cleanFirstName,
          lastName: cleanLastName,
          email: cleanEmail,
          locale: currentLocale(),
          termsAccepted: true,
          privacyAccepted: true,
          marketingConsent: consent.checked,
        }),
      });

      const returnTo = safeReturnPath();

      sessionStorage.removeItem('r2nette.returnTo');

      window.location.assign(returnTo);
    } catch (error) {
      showError(
        error instanceof Error
          ? error.message
          : 'Unable to create your account.',
      );
    } finally {
      button.disabled = false;
      label.textContent = 'Create account & continue';
    }
  });
}

if (page === 'login') {
  initializeLoginPage();
}

if (page === 'verify') {
  initializeVerifyPage();
}

if (page === 'signup') {
  initializeSignupPage();
}
