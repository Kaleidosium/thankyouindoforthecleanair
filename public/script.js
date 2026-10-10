import { initializeApp } from "firebase/app";
import {
  CustomProvider,
  initializeAppCheck,
  getToken,
} from "firebase/app-check";
import {
  getDatabase,
  ref,
  onValue,
  increment,
  set,
  goOffline,
  goOnline,
} from "firebase/database";
import {
  loadTurnstile,
  createTurnstileProvider,
} from "./turnstile-app-check.js?v=20261010-2";

const app = initializeApp({
  apiKey: "AIzaSyA1hciiiNxGqnf8OGfOn_706-A7XEyWpyg",
  databaseURL: "https://thankyouindoforthecleanair.firebaseio.com",
  projectId: "thankyouindoforthecleanair",
  appId: "1:202426334002:web:94db24c6ca4e633b10b52b",
});

let appCheck;
let database;
let counterRef;
let counterSubscribed = false;
let verificationState = "verifying";
let verificationMessage = "";
let counterError = "";
let connected = false;
let counterLoaded = false;
let incrementPending = false;

const counterElement = document.querySelector(".thanks--counter");
const verificationStatus = document.getElementById("verification-status");
const verificationRetry = document.getElementById("verification-retry");
const incrementButton = document.getElementById("big-red-button");

function updateControls() {
  incrementButton.disabled =
    verificationState !== "verified" || !counterLoaded || !connected ||
    !!counterError || incrementPending;
  verificationRetry.hidden = verificationState !== "error" && !counterError;
  verificationRetry.disabled = verificationState === "verifying";
  verificationStatus.textContent =
    counterError || verificationMessage ||
    (incrementPending ?
      connected ? "Saving..." : "Waiting for a connection... Keep this page open."
    : verificationState !== "verified" ? "Checking your browser..."
    : !connected ? "Waiting for a connection..."
    : !counterLoaded ? "Loading the thank-you count..."
    : "You can thank Indonesia now.");
}

function setVerificationStatus(state, message = "") {
  verificationState = state;
  verificationMessage = message;
  if (database && state === "error") goOffline(database);
  if (database && state === "verified") goOnline(database);
  updateControls();
}

async function connectCounter(forceRefresh = false) {
  setVerificationStatus("verifying");
  try {
    if (!appCheck) {
      const turnstile = await loadTurnstile();
      const provider = createTurnstileProvider(turnstile, "#turnstile-widget", {
        endpoint:
          "https://thankyouindo-app-check.thankyouindoforthecleanair.workers.dev/api/app-check",
        onStatus: setVerificationStatus,
      });
      // Initialize App Check before opening any database connection.
      appCheck = initializeAppCheck(app, {
        provider: new CustomProvider(provider),
        isTokenAutoRefreshEnabled: true,
      });
    }
    await getToken(appCheck, forceRefresh);
    if (!database) {
      database = getDatabase(app);
      counterRef = ref(database, "incremental_counter");
      onValue(ref(database, ".info/connected"), (snapshot) => {
        connected = snapshot.val() === true;
        updateControls();
      });
    }
    if (!counterSubscribed) {
      counterError = "";
      counterSubscribed = true;
      onValue(
        counterRef,
        (snapshot) => {
          counterElement.textContent = (snapshot.val() || 0).toLocaleString();
          counterLoaded = true;
          updateControls();
        },
        () => {
          counterSubscribed = false;
          counterLoaded = false;
          counterError = "The thank-you count didn't load. Try again.";
          goOffline(database);
          updateControls();
        },
      );
    }
    setVerificationStatus("verified");
  } catch {
    setVerificationStatus(
      "error",
      "The browser check failed. Try again.",
    );
  }
}

verificationRetry.addEventListener("click", () => connectCounter(true));
connectCounter();

let localCount = 0;
let persistLocalCount = true;
const localCounterDisplay = document.getElementById(
  "timesUserHasThankedIndonesia",
);
function readLocalCount() {
  if (!persistLocalCount) return localCount;
  try {
    const value = Number(localStorage.getItem("localCount"));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    persistLocalCount = false;
    return localCount;
  }
}

function displayLocalCount() {
  localCounterDisplay.textContent = localCount.toLocaleString();
}

localCount = readLocalCount();
displayLocalCount();
window.addEventListener("storage", (event) => {
  if (persistLocalCount && (event.key === "localCount" || event.key === null)) {
    localCount = readLocalCount();
    displayLocalCount();
  }
});

async function increaseThanksLocally() {
  const update = () => {
    localCount = Math.max(localCount, readLocalCount()) + 1;
    displayLocalCount();
    if (!persistLocalCount) return;
    try {
      localStorage.setItem("localCount", localCount);
    } catch {
      // Storage is optional; a committed thank-you still counts for this visit.
      persistLocalCount = false;
    }
  };
  try {
    await navigator.locks.request("localCount", update);
  } catch {
    // Keep shared storage unchanged when the browser cannot lock it.
    persistLocalCount = false;
    update();
  }
}

const thankYouSound = new Audio("assets/thankyou.m4a");

incrementButton.addEventListener("click", async () => {
  if (incrementButton.disabled) return;
  incrementPending = true;
  updateControls();
  try {
    // Start playback while this click still permits audio.
    thankYouSound
      .cloneNode(true)
      .play()
      .catch(() => {});
    await set(counterRef, increment(1));
    await increaseThanksLocally();
    generateQuote();
  } catch {
    setVerificationStatus(
      "error",
      "Your thank-you wasn't saved. Try again.",
    );
  } finally {
    incrementPending = false;
    updateControls();
  }
});

const responses = [
  "Ju-Suf Power!",
  "Kopi, Tea or Me?",
  "Kalla Thank you!",
  "Steady brudder!",
  "I rock!",
  "I heart you!",
  "No worries Buddy!",
  "*Like*",
  "That's alright *smiles*",
  "Indonesia STRONK",
  "Booyah!",
];

function generateQuote() {
  const responseText = responses[Math.floor(Math.random() * responses.length)];
  const quoteElements = document.getElementsByClassName("jusuf--quotes");

  for (let el of quoteElements) {
    el.textContent = responseText;
  }
}
