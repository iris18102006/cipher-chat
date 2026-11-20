// Writing a post, and editing one: the same form for both. Words, up to four pictures (or one
// video), one song, and who gets to see it. Loaded after feed.js.
// Uses $, el from app.js, sendJson from profile-media.js and plainButton from dialogs.js.
//
// Files are uploaded the moment you pick them (the server checks them) and wait as drafts until
// you press Post or Save. Nothing you type or pick is ever put in the page as html.

const POST_MAX = 500;
const NOTE_MAX = 300;
const MEDIA_LIMITS = { image: 4 * 1024 * 1024, video: 25 * 1024 * 1024, audio: 6 * 1024 * 1024 };
const MAX_PICTURES = 4;

const AUDIENCE_OPTIONS = [
  ["friends", "\u{1f465} All my friends"],
  ["close", "\u2605 Close friends only"],
  ["me", "\u{1f512} Only me"],
];

// what each kind of audience looks like on a post
const AUDIENCE_LABELS = { friends: "friends", close: "\u2605 close friends", me: "\u{1f512} only me" };

function mediaKindOf(file) {
  const t = file.type || "";
  if (t.startsWith("image/")) return "image";
  if (t === "video/mp4" || t === "video/webm") return "video";
  if (t.startsWith("audio/")) return "audio";
  return null;
}

// one upload, with progress (fetch can't tell how far an upload got)
function uploadPostMedia(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/post-media");
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {}
      if (xhr.status === 401) {
        location.href = "/login.html";
        reject(new Error("not logged in"));
      } else if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
      } else {
        reject(new Error(typeof data.detail === "string" ? data.detail : "that file didn't upload, try again"));
      }
    };
    xhr.onerror = () => reject(new Error("couldn't upload that, check your connection"));
    xhr.send(file);
  });
}

