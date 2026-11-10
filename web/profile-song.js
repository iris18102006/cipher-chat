// The song on a profile: a small player on the page and the upload controls in the editor.
// Loaded after profile-media.js, which provides sendFile. Uses el, pfCurrent and section
// from the files before it.
//
// Nothing here uses innerHTML. The player is an <audio> element that only ever gets a
// /api/song/<number> address from the server, and it never starts by itself: browsers don't
// allow that, and a page that makes noise when you open it is rude anyway.

const SONG_MAX_MB = 6;
const SONG_ACCEPT = ".mp3,.ogg,.oga,.wav,.flac,.m4a,audio/*";
const SONG_URL_RE = /^\/api\/song\/\d+$/;

let activeSong = null; // the <audio> that is playing, only one at a time

// stop whatever is playing (the page is closing, or being redrawn)
function stopProfileSong() {
  if (activeSong) {
    activeSong.pause();
    activeSong.removeAttribute("src");
    activeSong.load();
  }
  activeSong = null;
}

// 75 -> "1:15"
function songClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const whole = Math.floor(seconds);
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

function songPlayer(url, label) {
  const box = el("div", "pf-player");
  if (!SONG_URL_RE.test(url)) {
    box.append(el("span", "pf-player-error", "this song can't be played"));
    return box;
  }
  const audio = new Audio();
  audio.preload = "none"; // nothing is downloaded until somebody presses play
  audio.src = url;
  audio.volume = 0.7;

  const play = el("button", "pf-play", "\u25b6");
  play.type = "button";
  play.setAttribute("aria-label", "play " + (label || "song"));

  const seek = el("input", "pf-seek");
  seek.type = "range";
  seek.min = "0";
  seek.max = "1000";
  seek.value = "0";
  seek.disabled = true;
  seek.setAttribute("aria-label", "seek");

  const time = el("span", "pf-time", "0:00");

  const vol = el("input", "pf-vol");
  vol.type = "range";
  vol.min = "0";
  vol.max = "100";
  vol.value = "70";
  vol.setAttribute("aria-label", "volume");
  vol.oninput = () => (audio.volume = Number(vol.value) / 100);

  const paint = () => {
    const known = Number.isFinite(audio.duration) && audio.duration > 0;
    seek.disabled = !known;
    if (known) seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
    time.textContent = songClock(audio.currentTime) + (known ? " / " + songClock(audio.duration) : "");
  };

  play.onclick = () => {
    if (!audio.paused) {
      audio.pause();
      return;
    }
    if (activeSong && activeSong !== audio) activeSong.pause();
    activeSong = audio;
    box.classList.remove("failed");
    audio.play().catch(() => box.classList.add("failed"));
  };
  seek.oninput = () => {
    if (Number.isFinite(audio.duration)) audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
  };
  audio.onplay = () => {
    play.textContent = "\u275a\u275a";
    play.setAttribute("aria-label", "pause");
    box.classList.add("playing");
  };
  const stopped = () => {
    play.textContent = "\u25b6";
    play.setAttribute("aria-label", "play " + (label || "song"));
    box.classList.remove("playing");
  };
  audio.onpause = stopped;
  audio.onended = () => {
    stopped();
    audio.currentTime = 0;
    paint();
  };
  audio.onerror = () => {
    stopped();
    box.classList.add("failed");
  };
  audio.ontimeupdate = paint;
  audio.onloadedmetadata = paint;
  audio.ondurationchange = paint;

  const bars = el("span", "pf-bars"); // three little bars that dance while it plays
  bars.append(el("i"), el("i"), el("i"));
  box.append(play, bars, seek, time, vol, el("span", "pf-player-error", "couldn't play this song"));
  return box;
}

// the "Now playing" part of a profile: the text they wrote, and a player if they have a file
function songSection(p) {
  const box = el("div", "pf-section pf-song");
  box.append(el("h3", "", "Now playing"));
  const body = el("div", "pf-content");
  if (p.song) body.append(el("div", "pf-song-name", p.song));
  if (p.song_url) body.append(songPlayer(p.song_url, p.song));
  box.append(body);
  return box;
}
