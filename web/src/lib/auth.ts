interface ApiFailure {
    error?: {
      code?: string;
      message?: string;
    };
  }
  
  interface SendCodeResponse {
    sent: boolean;
    message: string;
    maskedPhone: string;
  }
  
  interface VerifyCodeResponse {
    customer: {
      id: string;
      firstName: string | null;
      email: string | null;
      isReturningCustomer: boolean;
    };
  }
  
  interface CustomerResponse {
    customer: {
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      verifiedPhone: string | null;
      isReturningCustomer: boolean;
    };
  }
  
  type AuthPage = "login" | "verify" | "signup";
  
  const page = document.body.dataset.authPage as AuthPage | undefined;
  
  function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
  
    if (!found) {
      throw new Error(`Missing required element: #${id}`);
    }
  
    return found as T;
  }
  
  function showError(message: string): void {
    const error = document.getElementById("error");
  
    if (!error) return;
  
    error.textContent = message;
    error.hidden = message.length === 0;
  }
  
  function safeReturnPath(): string {
    const parameters = new URLSearchParams(window.location.search);
  
    const requested =
      parameters.get("returnTo") ??
      sessionStorage.getItem("r2nette.returnTo") ??
      "/account";
  
    if (!requested.startsWith("/") || requested.startsWith("//")) {
      return "/account";
    }
  
    return requested;
  }
  
  async function apiRequest<T>(
    path: string,
    initialization: RequestInit = {},
  ): Promise<T> {
    const response = await fetch(path, {
      ...initialization,
  
      headers: {
        "Content-Type": "application/json",
        ...(initialization.headers ?? {}),
      },
  
      credentials: "same-origin",
    });
  
    const body = (await response.json().catch(() => ({}))) as
      | T
      | ApiFailure;
  
    if (!response.ok) {
      const failure = body as ApiFailure;
  
      throw new Error(
        failure.error?.message ??
          "Something went wrong. Please try again.",
      );
    }
  
    return body as T;
  }
  
  function initializeLoginPage(): void {
    const form = element<HTMLFormElement>("phoneForm");
    const phoneInput = element<HTMLInputElement>("phone");
    const button = element<HTMLButtonElement>("submitButton");
    const label = element<HTMLSpanElement>("submitLabel");
  
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("");
  
      const phone = phoneInput.value.trim();
  
      if (!phone) {
        showError("Enter your mobile number.");
        phoneInput.focus();
        return;
      }
  
      button.disabled = true;
      label.textContent = "Sending…";
  
      try {
        const result = await apiRequest<SendCodeResponse>(
          "/api/v1/auth/phone/send",
          {
            method: "POST",
            body: JSON.stringify({ phone }),
          },
        );
  
        sessionStorage.setItem("r2nette.authPhone", phone);
        sessionStorage.setItem(
          "r2nette.maskedPhone",
          result.maskedPhone,
        );
  
        sessionStorage.setItem(
          "r2nette.returnTo",
          safeReturnPath(),
        );
  
        window.location.assign("/verify");
      } catch (error) {
        showError(
          error instanceof Error
            ? error.message
            : "Unable to send the verification code.",
        );
      } finally {
        button.disabled = false;
        label.textContent = "Send verification code";
      }
    });
  }
  
  function initializeVerifyPage(): void {
    const phone = sessionStorage.getItem("r2nette.authPhone");
  
    if (!phone) {
      window.location.replace("/login");
      return;
    }
  
    const maskedPhone = document.getElementById("maskedPhone");
  
    if (maskedPhone) {
      maskedPhone.textContent =
        sessionStorage.getItem("r2nette.maskedPhone") ?? phone;
    }
  
    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-otp]"),
    );
  
    const verifyButton =
      element<HTMLButtonElement>("verifyButton");
  
    const resendButton =
      element<HTMLButtonElement>("resendButton");
  
    let verifying = false;
    let resendSeconds = 30;
    let resendTimer: number | undefined;
  
    function codeValue(): string {
      return inputs.map((input) => input.value).join("");
    }
  
    function setInputsDisabled(disabled: boolean): void {
      inputs.forEach((input) => {
        input.disabled = disabled;
      });
    }
  
    function clearInputs(): void {
      inputs.forEach((input) => {
        input.value = "";
      });
  
      inputs[0]?.focus();
    }
  
    async function verifyCode(): Promise<void> {
      const code = codeValue();
  
      if (code.length !== 6 || verifying) return;
  
      verifying = true;
      showError("");
      setInputsDisabled(true);
  
      verifyButton.disabled = true;
      verifyButton.textContent = "Verifying…";
  
      try {
        const result = await apiRequest<VerifyCodeResponse>(
          "/api/v1/auth/phone/verify",
          {
            method: "POST",
            body: JSON.stringify({
              phone,
              code,
            }),
          },
        );
  
        sessionStorage.removeItem("r2nette.authPhone");
        sessionStorage.removeItem("r2nette.maskedPhone");
  
        const returnTo = safeReturnPath();
  
        if (result.customer.isReturningCustomer) {
          sessionStorage.removeItem("r2nette.returnTo");
          window.location.assign(returnTo);
          return;
        }
  
        window.location.assign(
          `/signup?returnTo=${encodeURIComponent(returnTo)}`,
        );
      } catch (error) {
        showError(
          error instanceof Error
            ? error.message
            : "That code was not accepted. Try again.",
        );
  
        setInputsDisabled(false);
        clearInputs();
      } finally {
        verifying = false;
        verifyButton.disabled = false;
        verifyButton.textContent = "Verify code";
      }
    }
  
    inputs.forEach((input, index) => {
      input.addEventListener("input", () => {
        input.value = input.value.replace(/\D/g, "").slice(-1);
  
        if (input.value) {
          inputs[index + 1]?.focus();
        }
  
        if (inputs.every((codeInput) => codeInput.value)) {
          void verifyCode();
        }
      });
  
      input.addEventListener("keydown", (event) => {
        if (
          event.key === "Backspace" &&
          !input.value &&
          index > 0
        ) {
          inputs[index - 1]?.focus();
        }
      });
  
      input.addEventListener("paste", (event) => {
        const digits =
          event.clipboardData
            ?.getData("text")
            .replace(/\D/g, "")
            .slice(0, 6) ?? "";
  
        if (digits.length !== 6) return;
  
        event.preventDefault();
  
        inputs.forEach((codeInput, digitIndex) => {
          codeInput.value = digits[digitIndex] ?? "";
        });
  
        void verifyCode();
      });
    });
  
    verifyButton.addEventListener("click", () => {
      if (codeValue().length !== 6) {
        showError("Enter the complete 6-digit code.");
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
      ).padStart(2, "0")}`;
  
      resendTimer = window.setInterval(() => {
        resendSeconds -= 1;
  
        if (resendSeconds <= 0) {
          window.clearInterval(resendTimer);
          resendButton.disabled = false;
          resendButton.textContent = "Resend code";
          return;
        }
  
        resendButton.textContent = `Resend code in 0:${String(
          resendSeconds,
        ).padStart(2, "0")}`;
      }, 1000);
    }
  
    resendButton.addEventListener("click", async () => {
      showError("");
      resendButton.disabled = true;
  
      try {
        const result = await apiRequest<SendCodeResponse>(
          "/api/v1/auth/phone/send",
          {
            method: "POST",
            body: JSON.stringify({ phone }),
          },
        );
  
        sessionStorage.setItem(
          "r2nette.maskedPhone",
          result.maskedPhone,
        );
  
        if (maskedPhone) {
          maskedPhone.textContent = result.maskedPhone;
        }
  
        startResendTimer();
      } catch (error) {
        resendButton.disabled = false;
  
        showError(
          error instanceof Error
            ? error.message
            : "Unable to resend the code.",
        );
      }
    });
  
    startResendTimer();
  }
  
  function initializeSignupPage(): void {
    const form = element<HTMLFormElement>("profileForm");
    const firstName = element<HTMLInputElement>("firstName");
    const lastName = element<HTMLInputElement>("lastName");
    const email = element<HTMLInputElement>("email");
    const consent = element<HTMLInputElement>("consent");
    const button = element<HTMLButtonElement>("submitButton");
    const label = element<HTMLSpanElement>("submitLabel");
  
    void apiRequest<CustomerResponse>("/api/v1/customer/me")
      .then((result) => {
        firstName.value = result.customer.firstName ?? "";
        lastName.value = result.customer.lastName ?? "";
        email.value = result.customer.email ?? "";
      })
      .catch(() => {
        window.location.replace("/login");
      });
  
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("");
  
      const cleanFirstName = firstName.value.trim();
      const cleanLastName = lastName.value.trim();
      const cleanEmail = email.value.trim();
  
      if (!cleanFirstName) {
        showError("Enter your first name.");
        firstName.focus();
        return;
      }
  
      if (!cleanLastName) {
        showError("Enter your last name.");
        lastName.focus();
        return;
      }
  
      if (
        cleanEmail &&
        !/^\S+@\S+\.\S{2,}$/.test(cleanEmail)
      ) {
        showError("Enter a valid email address.");
        email.focus();
        return;
      }
  
      button.disabled = true;
      label.textContent = "Saving…";
  
      try {
        await apiRequest<{
          firstName: string | null;
          lastName: string | null;
          email: string | null;
        }>("/api/v1/account/profile", {
          method: "PATCH",
  
          body: JSON.stringify({
            firstName: cleanFirstName,
            lastName: cleanLastName,
            email: cleanEmail || undefined,
          }),
        });
  
        if (cleanEmail && consent.checked) {
          await apiRequest("/api/v1/marketing/leads", {
            method: "POST",
  
            body: JSON.stringify({
              email: cleanEmail,
              locale: "en",
              consent: true,
              source: "WELCOME_MODAL",
            }),
          }).catch(() => undefined);
        }
  
        const returnTo = safeReturnPath();
  
        sessionStorage.removeItem("r2nette.returnTo");
  
        window.location.assign(returnTo);
      } catch (error) {
        showError(
          error instanceof Error
            ? error.message
            : "Unable to create your account.",
        );
      } finally {
        button.disabled = false;
        label.textContent = "Create account & continue";
      }
    });
  }
  
  if (page === "login") {
    initializeLoginPage();
  }
  
  if (page === "verify") {
    initializeVerifyPage();
  }
  
  if (page === "signup") {
    initializeSignupPage();
  }