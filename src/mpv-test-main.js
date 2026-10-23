const { app } = require("electron");
const { bootstrapMpvTest } = require("./modules/mpv/testMode");
bootstrapMpvTest(app);
if (process.argv.includes("--mpv-test-window-log")) {
  app.on("browser-window-created", (_event, window) => {
    for (const event of [
      "show",
      "hide",
      "minimize",
      "restore",
      "focus",
      "blur",
    ]) {
      window.on(event, () => {
        if (window.isDestroyed()) return;
        console.log(
          "MPV_TEST_WINDOW",
          JSON.stringify({
            at: Date.now(),
            event,
            visible: window.isVisible(),
            minimized: window.isMinimized(),
            alwaysOnTop: window.isAlwaysOnTop(),
            focused: window.isFocused(),
          }),
        );
      });
    }
  });
}
require("./main");
