export const TURNSTILE_SITE_KEY = "0x4AAAAAAFS8y0F1moXVqQX1";
export const TURNSTILE_ACTION = "firebase_app_check";

export function loadTurnstile() {
  return new Promise((resolve, reject) => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }
    const script = document.createElement("script");
    script.src =
      "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const timer = setTimeout(() => script.onerror(), 20_000);
    // api.js initializes the explicit-render API before the load event.
    // turnstile.ready() requires a synchronous script tag.
    script.onload = () => {
      clearTimeout(timer);
      resolve(window.turnstile);
    };
    script.onerror = () => {
      clearTimeout(timer);
      script.remove();
      reject(new Error("The browser check didn't load. Try again."));
    };
    document.head.appendChild(script);
  });
}

export function createTurnstileProvider(
  turnstile,
  container,
  {
    endpoint,
    fetchImpl = fetch,
    onStatus = () => {},
    timeoutMillis = 120_000,
  } = {},
) {
  let pending;
  let resolveChallenge;
  let rejectChallenge;

  const widgetId = turnstile.render(container, {
    sitekey: TURNSTILE_SITE_KEY,
    action: TURNSTILE_ACTION,
    execution: "execute",
    appearance: "interaction-only",
    callback: (token) => resolveChallenge?.(token),
    "error-callback": () => {
      rejectChallenge?.(new Error("The browser check failed. Try again."));
      return true;
    },
    "expired-callback": () =>
      rejectChallenge?.(new Error("The browser check expired. Try again.")),
    "timeout-callback": () =>
      rejectChallenge?.(
        new Error("The browser check took too long. Try again."),
      ),
  });

  return {
    getToken() {
      // App Check can ask for a token from several services at the same time.
      if (pending) return pending;
      pending = Promise.resolve().then(async () => {
        let timer;
        onStatus("verifying");
        try {
          const token = await new Promise((resolve, reject) => {
            resolveChallenge = resolve;
            rejectChallenge = reject;
            timer = setTimeout(
              () =>
                reject(
                  new Error("The browser check took too long. Try again."),
                ),
              timeoutMillis,
            );
            turnstile.execute(widgetId);
          });
          clearTimeout(timer);
          resolveChallenge = undefined;
          rejectChallenge = undefined;

          const response = await fetchImpl(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "omit",
            cache: "no-store",
            signal: AbortSignal.timeout(20_000),
            body: JSON.stringify({ "cf-turnstile-response": token }),
          });
          if (!response.ok)
            throw new Error("The browser check failed. Try again.");
          const result = await response.json();
          if (
            typeof result.token !== "string" ||
            !result.token ||
            !Number.isFinite(result.expireTimeMillis) ||
            result.expireTimeMillis <= Date.now()
          ) {
            throw new Error("The browser check failed. Try again.");
          }
          onStatus("verified");
          return result;
        } catch (error) {
          onStatus("error", error.message);
          throw error;
        } finally {
          clearTimeout(timer);
          resolveChallenge = undefined;
          rejectChallenge = undefined;
          // Turnstile tokens are single-use, including after a failed exchange.
          turnstile.reset(widgetId);
          pending = undefined;
        }
      });
      return pending;
    },
  };
}
