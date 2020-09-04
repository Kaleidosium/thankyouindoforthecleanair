/* Global Thanks Counter Tracker */

document.addEventListener("DOMContentLoaded", function () {
  const counter = document.getElementsByClassName("thanks--counter")[0];
  const counterRef = firebase.database().ref("incremental_counter");
  counterRef.on("value", (snapshot) => {
    counter.textContent = snapshot.val();
  });

  const incrementButton = document.getElementsByClassName(
    "thanks--increment"
  )[0];
  incrementButton.addEventListener(
    "click",
    () => {
      counterRef.set(firebase.database.ServerValue.increment(1));
    },
    false
  );
});

/* Local Thanks Counter Tracker */

if (!localStorage.hasOwnProperty("localCount")) {
  localStorage.setItem("localCount", 0);
}
let count = localStorage.getItem("localCount");

document.getElementById("timesUserHasThankedIndonesia").innerHTML = count;

function increaseThanksLocally() {
  document.getElementById("timesUserHasThankedIndonesia").innerHTML = ++count;
  localStorage.setItem("localCount", count);
}

/* Play Music */

let isAudioEnabled = true;

document.getElementById("big-red-button").addEventListener(
  "click",
  function (event) {
    MIDIjs.play("/assets/music.mid");
    document.getElementById("disable--audio").style.display = "block";
  },
  { once: true }
);

document
  .getElementById("disable--audio")
  .addEventListener("click", function (event) {
    if (isAudioEnabled) {
      isAudioEnabled = false;
      MIDIjs.pause();
      document.getElementById("state-audio--text").innerHTML = "enable";
    } else {
      isAudioEnabled = true;
      MIDIjs.resume();
      document.getElementById("state-audio--text").innerHTML = "disable";
    }
  });

/* Jusuf Kalla Quotes */

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

document
  .getElementById("big-red-button")
  .addEventListener("click", function (event) {
    const responseText =
      responses[Math.floor(Math.random() * responses.length)];
    document.getElementsByClassName(
      "jusuf--quotes"
    )[0].innerHTML = responseText;
    document.getElementsByClassName(
      "jusuf--quotes"
    )[1].innerHTML = responseText;
  });
