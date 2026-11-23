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
  ["friends", "All my friends"],
  ["close", "Close friends only"],
  ["me", "Only me"],
];

// what each kind of audience looks like on a post
const AUDIENCE_LABELS = { friends: "friends", close: "close friends", me: "only me" };
const AUDIENCE_ICONS = { friends: "users", close: "star", me: "lock" };

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

// opts: { post (to edit it), onDone(post), onCancel }. Gives back the form.
function makeComposer(opts) {
  const editing = !!opts.post;
  const isRepost = editing && opts.post.is_repost;
  const limit = isRepost ? NOTE_MAX : POST_MAX;
  const items = editing ? (opts.post.media || []).map((m) => ({ ...m })) : [];
  let uploading = 0;

  const form = el("form", "fc");
  form.autocomplete = "off";

  const label = el("label", "feed-label", isRepost ? "Your note" : editing ? "Edit your post" : "What's on your mind?");
  const text = el("textarea");
  text.id = editing ? "fc-edit-text" : "feed-text";
  label.htmlFor = text.id;
  text.rows = editing ? 4 : 3;
  text.maxLength = limit;
  text.placeholder = isRepost ? "add a note (optional)" : "say something to your friends...";
  if (editing) text.value = opts.post.body;

  const chips = el("div", "fc-chips");
  const err = el("p", "fc-error");
  err.setAttribute("role", "alert");
  err.hidden = true;
  const showError = (msg) => {
    err.textContent = msg || "";
    err.hidden = !msg;
  };

  // ----- the files -----
  const files = el("input");
  files.type = "file";
  files.hidden = true;
  files.multiple = true;
  const addMenu = el("div", "fc-add");
  const kinds = [
    ["image", "Photo or GIF", "image/png,image/jpeg,image/gif,image/webp"],
    ["video", "Video", "video/mp4,video/webm"],
    ["audio", "Music", "audio/mpeg,audio/ogg,audio/wav,audio/flac,audio/mp4,audio/x-m4a,.mp3,.m4a,.ogg,.wav,.flac"],
  ];
  let picking = "image";
  if (!isRepost) {
    addMenu.append(
      iconButton("image", "GIFs", () => {
        if (typeof openGifsForPost === "function") openGifsForPost(addGifFile);
      })
    );
    for (const [kind, name, accept] of kinds) {
      addMenu.append(
        iconButton(kind === "image" ? "image" : kind === "video" ? "video" : "music", name, () => {
          picking = kind;
          files.accept = accept;
          files.multiple = kind === "image";
          files.click();
        })
      );
    }
  }

  function count(kind) {
    return items.filter((i) => i.kind === kind).length;
  }

  // why this file can't be added, or "" if it can
  function whyNot(kind, file) {
    if (!kind) return "use a picture, an mp4 or webm video, or a song";
    if (file.size > MEDIA_LIMITS[kind]) return "that " + (kind === "audio" ? "song" : kind === "image" ? "picture" : "video") + " is too big (max " + MEDIA_LIMITS[kind] / (1024 * 1024) + " MB)";
    if (kind === "image" && count("image") >= MAX_PICTURES) return "a post can have up to " + MAX_PICTURES + " pictures";
    if (kind === "image" && count("video")) return "a post can have pictures or a video, not both";
    if (kind === "video" && (count("video") || count("image"))) return count("video") ? "a post can have one video" : "a post can have pictures or a video, not both";
    if (kind === "audio" && count("audio")) return "a post can have one song";
    return "";
  }

  async function addGifFile(file) {
    await addPickedFile(file, "image");
  }

  async function addPickedFile(file, forcedKind) {
    files.value = "";
    showError("");
    const kind = forcedKind || mediaKindOf(file);
    const why = whyNot(kind, file);
    if (why) return showError(why);
    const item = { kind, name: file.name, uploading: true, progress: 0, id: 0, url: "" };
    items.push(item);
    uploading++;
    paint();
    try {
      const made = await uploadPostMedia(file, (p) => {
        item.progress = p;
        paintProgress(item);
      });
      Object.assign(item, made, { uploading: false });
    } catch (ex) {
      items.splice(items.indexOf(item), 1);
      showError(ex.message);
    }
    uploading--;
    paint();
  }

  files.onchange = async () => {
    for (const file of [...files.files]) await addPickedFile(file);
  };

  const progressBars = new Map();
  function paintProgress(item) {
    const bar = progressBars.get(item);
    if (bar) bar.value = Math.round(item.progress * 100);
  }

  function chip(item) {
    const box = el("div", "fc-chip fc-" + item.kind);
    if (item.uploading) {
      const bar = el("progress");
      bar.max = 100;
      bar.value = Math.round(item.progress * 100);
      progressBars.set(item, bar);
      box.append(el("span", "fc-name", "uploading " + item.name + "..."), bar);
      return box;
    }
    if (item.kind === "image") {
      const img = el("img");
      img.src = item.url;
      img.alt = "";
      box.append(img);
    } else if (item.kind === "video") {
      const ic = el("span", "fc-icon");
      ic.append(icon("video"));
      box.append(ic, el("span", "fc-name", "video"));
    } else {
      const ic = el("span", "fc-icon");
      ic.append(icon("music"));
      box.append(ic, el("span", "fc-name", "song"));
    }
    const remove = plainButton("\u00d7", () => {
      items.splice(items.indexOf(item), 1);
      // a file that was only a draft goes away at once, one that is on the post goes when you save
      if (!editing || !(opts.post.media || []).some((m) => m.id === item.id)) {
        fetch("/api/post-media/" + item.id, { method: "DELETE" }).catch(() => {});
      }
      paint();
    }, "fc-remove");
    remove.setAttribute("aria-label", "remove this " + item.kind);
    box.append(remove);
    return box;
  }

  // ----- the rest of the form -----
  const audience = el("select");
  audience.setAttribute("aria-label", "who can see this post");
  for (const [value, name] of AUDIENCE_OPTIONS) {
    const o = el("option", "", name);
    o.value = value;
    audience.append(o);
  }
  audience.value = editing ? opts.post.audience : (feed.settings && feed.settings.post_audience) || "friends";

  const chars = el("span", "fc-chars");
  const submit = el("button", "fc-submit", editing ? "Save" : "Post");
  submit.type = "submit";
  const hint = el("span", "fc-hint", "Ctrl+Enter " + (editing ? "saves" : "posts"));
  const row = el("div", "fc-row");
  row.append(audience, hint, chars);
  if (editing) row.append(plainButton("Cancel", () => opts.onCancel && opts.onCancel()));
  row.append(submit);

  const rules = el("p", "fc-rules");
  rules.append(
    "Photos, videos and music are only shown to the people you pick. No nudity, violence or anything harmful: pictures are checked, and posts that get reported are hidden until they are looked at."
  );

  function paint() {
    progressBars.clear();
    chips.replaceChildren(...items.map(chip));
    const left = limit - text.value.length;
    chars.textContent = String(left);
    chars.classList.toggle("low", left <= 50);
    const empty = text.value.trim() === "" && items.length === 0;
    submit.disabled = uploading > 0 || (empty && !isRepost);
    for (const b of addMenu.querySelectorAll("button")) b.disabled = uploading > 0;
  }

  text.addEventListener("input", paint);
  text.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    showError("");
    submit.disabled = true;
    const payload = { body: text.value.trim(), audience: audience.value };
    if (!isRepost) payload.media = items.map((i) => i.id);
    try {
      const post = editing
        ? await sendJson("/api/posts/" + opts.post.id, "PATCH", payload)
        : await sendJson("/api/posts", "POST", payload);
      if (!editing) {
        text.value = "";
        items.length = 0;
      }
      if (opts.onDone) opts.onDone(post);
    } catch (ex) {
      showError(ex.message); // sendJson only throws messages that are safe to show
    } finally {
      paint();
    }
  };

  form.append(label, text, chips, err, files, row);
  if (!isRepost) form.insertBefore(addMenu, row);
  form.append(rules);
  paint();
  return form;
}

// the page may have been opened with #feed or #post-12 in the address
routeFromHash();
