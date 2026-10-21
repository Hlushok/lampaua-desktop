const { app, net } = require("electron");

// Use Chromium networking, including explicit cancellation of streaming bodies.
async function electronNetFetch(input, options = {}) {
  if (!app.isReady())
    throw new Error("Electron network requests require app.whenReady()");
  const abort = new AbortController();
  const headersTimeout = setTimeout(
    () =>
      abort.abort(
        new DOMException("Server response timed out", "TimeoutError"),
      ),
    30_000,
  );
  headersTimeout.unref();
  let response;
  try {
    response = await net.fetch(input, {
      ...options,
      signal: AbortSignal.any(
        [abort.signal, input?.signal, options.signal].filter(Boolean),
      ),
      bypassCustomProtocolHandlers: true,
    });
  } finally {
    clearTimeout(headersTimeout);
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let finished = false;
  const body = new ReadableStream(
    {
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (finished) return;
          if (done) {
            finished = true;
            reader.releaseLock();
            controller.close();
          } else controller.enqueue(value);
        } catch (error) {
          if (!finished) {
            finished = true;
            reader.releaseLock();
            controller.error(error);
          }
          abort.abort(error);
        }
      },
      async cancel(reason) {
        finished = true;
        abort.abort(reason);
        await reader.cancel(reason).catch(() => {});
        reader.releaseLock();
      },
    },
    { highWaterMark: 0 },
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

module.exports = { electronNetFetch };
