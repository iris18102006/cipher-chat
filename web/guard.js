fetch("/api/me").then((res) => {
  if (!res.ok) location.href = "/login.html";
});
