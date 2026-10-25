const errorEl = document.getElementById("error");

async function submit(path, form) {
  errorEl.textContent = "";
  const username = form.elements.username.value;
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
  } catch {
    errorEl.textContent = "can't reach the server, is it running?";
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
