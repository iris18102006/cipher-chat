// Login and sign up. Posts the form to the API and shows what went wrong;
// on success the server has set the session cookie, so we just go to the chat.

const errorEl = document.getElementById("error");

async function submit(path, form) {
  errorEl.textContent = "";
  const button = form.querySelector("button");
  button.disabled = true;
  const username = form.elements.username.value.trim();
  const password = form.elements.password.value;
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (res.ok) {
      location.href = "/";
      return;
    }
    let message = "something went wrong, try again";
    if (res.status === 422) {
      message = "please fill in both fields";
    } else {
      const data = await res.json().catch(() => ({}));
      if (typeof data.detail === "string") message = data.detail;
    }
    errorEl.textContent = message;
    if (res.status === 401) {
      form.elements.password.value = "";
      form.elements.password.focus();
    }
  } catch {
    errorEl.textContent = "can't reach the server, is it running?";
  } finally {
    button.disabled = false;
  }
}

document.getElementById("login-form").onsubmit = (e) => {
  e.preventDefault();
  submit("/api/login", e.target);
};

document.getElementById("signup-form").onsubmit = (e) => {
  e.preventDefault();
  submit("/api/signup", e.target);
};
