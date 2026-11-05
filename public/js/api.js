window.apiRequest = async function apiRequest(path, options = {}, { retryNetworkError = false } = {}) {
  const backendPath = path.startsWith("/") ? path : `/${path}`;
  const maxAttempts = retryNetworkError ? 4 : 1;
  let response;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await fetch(`/api${backendPath}`, options);
      break;
    } catch (error) {
      if (!(error instanceof TypeError) || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }

  const responseText = await response.text();
  let data = responseText;

  if (responseText) {
    try {
      data = JSON.parse(responseText);
    } catch {
      data = responseText;
    }
  } else {
    data = null;
  }

  if (!response.ok) {
    const message = data && typeof data === "object" && data.error
      ? data.error
      : `Error HTTP ${response.status}`;
    throw new Error(message);
  }

  return data;
};