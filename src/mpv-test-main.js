const { app } = require("electron");
const { bootstrapMpvTest } = require("./modules/mpv/testMode");
bootstrapMpvTest(app);
require("./main");
